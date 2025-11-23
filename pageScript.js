// This script runs in the page context to access cookies and make API calls
(function() {
  // Store essential headers from Twitter's own API calls
  let twitterHeaders = null;
  let headersReady = false;

  // Only capture essential headers needed for the API call
  const ESSENTIAL_HEADERS = [
    'authorization',
    'x-csrf-token',
    'x-twitter-auth-type',
    'x-twitter-active-user',
    'x-twitter-client-language',
  ];

  // Retry configuration (matches config.js)
  const RETRY_CONFIG = {
    MAX_ATTEMPTS: 3,
    INITIAL_DELAY_MS: 1000,
    MAX_DELAY_MS: 10000,
    BACKOFF_MULTIPLIER: 2,
    RETRYABLE_STATUS_CODES: [408, 500, 502, 503, 504],
  };

  // Function to capture only essential headers from a request
  function captureHeaders(headers) {
    if (!headers) return;

    const headerObj = {};

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (ESSENTIAL_HEADERS.some(h => h.toLowerCase() === lowerKey)) {
          headerObj[key] = value;
        }
      });
    } else if (headers instanceof Object) {
      // Only copy essential headers
      for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase();
        if (ESSENTIAL_HEADERS.some(h => h.toLowerCase() === lowerKey)) {
          headerObj[key] = value;
        }
      }
    }

    // Only update if we captured any essential headers
    if (Object.keys(headerObj).length > 0) {
      twitterHeaders = { ...twitterHeaders, ...headerObj };
      headersReady = true;
      // Log header names only, not values (for security)
      console.log('Captured Twitter API headers:', Object.keys(headerObj).join(', '));
    }
  }
  
  // Intercept fetch to capture Twitter's headers
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    const options = args[1] || {};
    
    // If it's a Twitter GraphQL API call, capture essential headers only
    if (typeof url === 'string' && url.includes('x.com/i/api/graphql')) {
      if (options.headers) {
        captureHeaders(options.headers);
      }
    }
    
    return originalFetch.apply(this, args);
  };
  
  // Also intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && this._url.includes('x.com/i/api/graphql')) {
      const headers = {};
      // Try to get headers from setRequestHeader
      if (this._headers) {
        Object.assign(headers, this._headers);
      }
      captureHeaders(headers);
    }
    return originalXHRSend.apply(this, args);
  };
  
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (!this._headers) this._headers = {};
    this._headers[header] = value;
    return originalSetRequestHeader.apply(this, [header, value]);
  };
  
  // Wait a bit for Twitter to make some API calls first
  setTimeout(() => {
    if (!headersReady) {
      console.log('No Twitter headers captured yet, using defaults');
      twitterHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };
      headersReady = true;
    }
  }, 3000);

  /**
   * Fetch location with retry logic and exponential backoff
   * @param {string} screenName - Twitter username
   * @param {number} attempt - Current attempt number (1-indexed)
   * @returns {Promise<{location: string|null, isRateLimited: boolean, status: number}>}
   */
  async function fetchLocationWithRetry(screenName, attempt = 1) {
    const variables = JSON.stringify({ screenName });
    const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(variables)}`;

    // Use captured headers or minimal defaults
    const headers = twitterHeaders || {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    try {
      // Ensure credentials are included
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: headers,
        referrer: window.location.href,
        referrerPolicy: 'origin-when-cross-origin'
      });

      let location = null;
      if (response.ok) {
        const data = await response.json();
        console.log(`API response for ${screenName}:`, data);
        location = data?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in || null;
        console.log(`Extracted location for ${screenName}:`, location);

        // Debug: log the full path to see what's available
        if (!location && data?.data?.user_result_by_screen_name?.result) {
          console.log('User result available but no location:', {
            hasAboutProfile: !!data.data.user_result_by_screen_name.result.about_profile,
            aboutProfile: data.data.user_result_by_screen_name.result.about_profile
          });
        }

        return { location, isRateLimited: false, status: response.status };
      } else {
        const errorText = await response.text().catch(() => '');

        // Handle rate limiting
        if (response.status === 429) {
          const resetTime = response.headers.get('x-rate-limit-reset');
          const remaining = response.headers.get('x-rate-limit-remaining');
          const limit = response.headers.get('x-rate-limit-limit');

          if (resetTime) {
            const resetDate = new Date(parseInt(resetTime) * 1000);
            const now = Date.now();
            const waitTime = resetDate.getTime() - now;

            console.log(`Rate limited! Limit: ${limit}, Remaining: ${remaining}`);
            console.log(`Rate limit resets at: ${resetDate.toLocaleString()}`);
            console.log(`Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes before retrying...`);

            // Store rate limit info for content script
            window.postMessage({
              type: '__rateLimitInfo',
              resetTime: parseInt(resetTime),
              waitTime: Math.max(0, waitTime)
            }, '*');
          }

          return { location: null, isRateLimited: true, status: 429 };
        }

        // Check if this error is retryable
        if (RETRY_CONFIG.RETRYABLE_STATUS_CODES.includes(response.status) && attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
          // Calculate exponential backoff delay
          const delay = Math.min(
            RETRY_CONFIG.INITIAL_DELAY_MS * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt - 1),
            RETRY_CONFIG.MAX_DELAY_MS
          );

          console.log(`Twitter API error ${response.status} for ${screenName}, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS})`);

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));

          // Retry
          return fetchLocationWithRetry(screenName, attempt + 1);
        }

        console.log(`Twitter API error for ${screenName}:`, response.status, response.statusText, errorText.substring(0, 200));
        return { location: null, isRateLimited: false, status: response.status };
      }
    } catch (error) {
      // Network errors or fetch failures
      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
        const delay = Math.min(
          RETRY_CONFIG.INITIAL_DELAY_MS * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt - 1),
          RETRY_CONFIG.MAX_DELAY_MS
        );

        console.log(`Network error fetching location for ${screenName}, retrying in ${delay}ms (attempt ${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS}):`, error.message);

        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchLocationWithRetry(screenName, attempt + 1);
      }

      console.error(`Error fetching location for ${screenName} after ${attempt} attempts:`, error);
      throw error;
    }
  }

  // Listen for fetch requests from content script via postMessage
  window.addEventListener('message', async function(event) {
    // Only accept messages from our extension
    if (event.data && event.data.type === '__fetchLocation') {
      const { screenName, requestId } = event.data;

      // Wait for headers to be ready
      if (!headersReady) {
        let waitCount = 0;
        while (!headersReady && waitCount < 30) {
          await new Promise(resolve => setTimeout(resolve, 100));
          waitCount++;
        }
      }

      try {
        const { location, isRateLimited, status } = await fetchLocationWithRetry(screenName);

        // Send response back to content script via postMessage
        window.postMessage({
          type: '__locationResponse',
          screenName,
          location,
          requestId,
          isRateLimited,
          status
        }, '*');
      } catch (error) {
        console.error('Error fetching location:', error);
        window.postMessage({
          type: '__locationResponse',
          screenName,
          location: null,
          requestId,
          isRateLimited: false
        }, '*');
      }
    }
  });
})();

