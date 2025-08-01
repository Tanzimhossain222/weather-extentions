import { NextRequest, NextResponse } from 'next/server';
import apiKeyManager from '../../../utils/apiKeyManager';

// Rate limiting in memory (in production, use Redis or similar)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Cache configuration for HTTP headers
const CACHE_CONFIG = {
  // Geocoding cache duration (in seconds) - coordinates don't change often
  GEOCODE_CACHE_DURATION: 86400, // 24 hours - coordinates are static
  // Error cache duration (cache errors briefly to avoid hammering bad keys)
  ERROR_CACHE_DURATION: 300, // 5 minutes
  // Rate limit cache duration
  RATE_LIMIT_CACHE: 60, // 1 minute
};

// Security configuration
const SECURITY_CONFIG = {
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 10000, // 10 seconds
  RATE_LIMIT: 60, // requests per minute
  RATE_LIMIT_WINDOW: 60000, // 1 minute
};

// Rate limiting function
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitMap.get(ip);

  if (!userLimit || now > userLimit.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + SECURITY_CONFIG.RATE_LIMIT_WINDOW });
    return true;
  }

  if (userLimit.count >= SECURITY_CONFIG.RATE_LIMIT) {
    return false;
  }

  userLimit.count++;
  return true;
}

// Coordinate validation
function validateCoordinates(lat: string | null, lon: string | null): { valid: boolean; error?: string } {
  if (!lat || !lon) {
    return { valid: false, error: 'Latitude and longitude are required' };
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return { valid: false, error: 'Invalid coordinates' };
  }

  if (latNum < -90 || latNum > 90) {
    return { valid: false, error: 'Latitude must be between -90 and 90' };
  }

  if (lonNum < -180 || lonNum > 180) {
    return { valid: false, error: 'Longitude must be between -180 and 180' };
  }

  return { valid: true };
}

// Coordinate sanitization
function sanitizeCoordinate(coord: string): string {
  return parseFloat(coord).toFixed(6);
}

// HTTP Cache headers helper - This is what Vercel's CDN will use
function getCacheHeaders(cacheDuration: number = CACHE_CONFIG.GEOCODE_CACHE_DURATION) {
  const now = new Date();
  const expires = new Date(now.getTime() + cacheDuration * 1000);

  return {
    'Cache-Control': `public, max-age=${cacheDuration}, s-maxage=${cacheDuration}, stale-while-revalidate=3600`,
    'Expires': expires.toUTCString(),
    'Last-Modified': now.toUTCString(),
    'ETag': `"geocode-${now.getTime()}"`,
    'X-Cache-Duration': cacheDuration.toString(),
  };
}

// No-cache headers for errors
function getNoCacheHeaders() {
  return {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  try {
    // Rate limiting check
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': SECURITY_CONFIG.RATE_LIMIT.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': new Date(Date.now() + SECURITY_CONFIG.RATE_LIMIT_WINDOW).toISOString(),
            ...getNoCacheHeaders(),
          }
        }
      );
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const lat = searchParams.get('lat');
    const lon = searchParams.get('lon');

    // Input validation
    const validation = validateCoordinates(lat, lon);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        {
          status: 400,
          headers: getNoCacheHeaders(),
        }
      );
    }

    // Sanitize inputs
    const sanitizedLat = sanitizeCoordinate(lat!);
    const sanitizedLon = sanitizeCoordinate(lon!);

    // Get API key using round-robin rotation
    const apiKey = apiKeyManager.getNextKey();

    // Build OpenWeather Geocoding API URL
    const geocodeUrl = new URL('https://api.openweathermap.org/geo/1.0/reverse');
    geocodeUrl.searchParams.set('lat', sanitizedLat);
    geocodeUrl.searchParams.set('lon', sanitizedLon);
    geocodeUrl.searchParams.set('limit', '1');
    geocodeUrl.searchParams.set('appid', apiKey);

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SECURITY_CONFIG.REQUEST_TIMEOUT);

    const response = await fetch(geocodeUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Weather-Extension-Backend/1.0',
      },
    });

    clearTimeout(timeoutId);

    // Handle different response status codes
    if (response.status === 401) {
      apiKeyManager.recordError(apiKey, 'Invalid API key');
      return NextResponse.json(
        { error: 'Geocoding service temporarily unavailable' },
        {
          status: 503,
          headers: getNoCacheHeaders(),
        }
      );
    }

    if (response.status === 404) {
      // Cache 404 responses briefly to avoid hammering
      return NextResponse.json(
        { error: 'Location not found' },
        {
          status: 404,
          headers: {
            ...getCacheHeaders(CACHE_CONFIG.ERROR_CACHE_DURATION),
            'X-Cache-Source': 'error-cache',
          }
        }
      );
    }

    if (response.status === 429) {
      apiKeyManager.recordError(apiKey, 'Rate limit exceeded');
      return NextResponse.json(
        { error: 'Geocoding service temporarily unavailable' },
        {
          status: 503,
          headers: getNoCacheHeaders(),
        }
      );
    }

    if (response.status === 500) {
      apiKeyManager.recordError(apiKey, 'OpenWeather API error');
      return NextResponse.json(
        { error: 'Geocoding service temporarily unavailable' },
        {
          status: 503,
          headers: getNoCacheHeaders(),
        }
      );
    }

    if (!response.ok) {
      apiKeyManager.recordError(apiKey, `HTTP ${response.status}`);
      return NextResponse.json(
        { error: 'Geocoding service temporarily unavailable' },
        {
          status: 503,
          headers: getNoCacheHeaders(),
        }
      );
    }

    // Parse response
    const data = await response.json();

    // Validate response structure
    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json(
        { error: 'Location not found' },
        {
          status: 404,
          headers: {
            ...getCacheHeaders(CACHE_CONFIG.ERROR_CACHE_DURATION),
            'X-Cache-Source': 'error-cache',
          }
        }
      );
    }

    const location = data[0];
    if (!location || !location.name) {
      apiKeyManager.recordError(apiKey, 'Invalid response structure');
      return NextResponse.json(
        { error: 'Invalid location data received' },
        {
          status: 500,
          headers: getNoCacheHeaders(),
        }
      );
    }

    // Record successful request
    apiKeyManager.recordSuccess(apiKey);

    // Return city name
    const result = {
      city: location.name,
      country: location.country,
      state: location.state,
    };

    // Add security headers and timing info
    const processingTime = Date.now() - startTime;

    return NextResponse.json(result, {
      headers: {
        ...getCacheHeaders(),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'geolocation=()',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Processing-Time': processingTime.toString(),
        'X-Cache-Source': 'vercel-cdn',
        'X-API-Keys-Available': apiKeyManager.getActiveKeyCount().toString(),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400',
      },
    });

  } catch (error) {
    console.error('Geocoding API error:', error);

    // Handle timeout
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Request timeout' },
        {
          status: 408,
          headers: getNoCacheHeaders(),
        }
      );
    }

    // Generic error response (don't expose internal details)
    return NextResponse.json(
      { error: 'Geocoding service temporarily unavailable' },
      {
        status: 503,
        headers: getNoCacheHeaders(),
      }
    );
  }
}
