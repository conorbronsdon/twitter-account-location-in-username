// Cache for user locations - persistent storage
let locationCache = new Map();

// Rate limiting
const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
let activeRequests = 0;
let rateLimitResetTime = 0; // Unix timestamp when rate limit resets

// Observers for dynamically loaded content and navigation
let contentObserver = null;
let navigationObserver = null;

// Extension enabled state
let extensionEnabled = true;

// Track usernames currently being processed to avoid duplicate requests
const processingUsernames = new Set();

// Debug logging utilities
const debug = {
  log: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED) {
      console.log(`[TwitterFlag] ${message}`, ...args);
    }
  },
  api: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED && CONFIG.DEBUG.LOG_API_REQUESTS) {
      console.log(`[TwitterFlag:API] ${message}`, ...args);
    }
  },
  cache: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED && CONFIG.DEBUG.LOG_CACHE_OPERATIONS) {
      console.log(`[TwitterFlag:Cache] ${message}`, ...args);
    }
  },
  username: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED && CONFIG.DEBUG.LOG_USERNAME_EXTRACTION) {
      console.log(`[TwitterFlag:Username] ${message}`, ...args);
    }
  },
  flag: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED && CONFIG.DEBUG.LOG_FLAG_INSERTION) {
      console.log(`[TwitterFlag:Flag] ${message}`, ...args);
    }
  },
  error: (message, ...args) => {
    // Always log errors
    console.error(`[TwitterFlag:Error] ${message}`, ...args);
  },
  warn: (message, ...args) => {
    if (CONFIG.DEBUG.ENABLED) {
      console.warn(`[TwitterFlag:Warning] ${message}`, ...args);
    }
  }
};

/**
 * Load extension enabled state from Chrome storage
 * @async
 * @returns {Promise<void>}
 */
async function loadEnabledState() {
  try {
    const result = await chrome.storage.local.get([CONFIG.STATE.TOGGLE_KEY]);
    extensionEnabled = result[CONFIG.STATE.TOGGLE_KEY] !== undefined ? result[CONFIG.STATE.TOGGLE_KEY] : CONFIG.STATE.DEFAULT_ENABLED;
    console.log('Extension enabled:', extensionEnabled);
  } catch (error) {
    console.error('Error loading enabled state:', error);
    extensionEnabled = CONFIG.STATE.DEFAULT_ENABLED;
  }
}

// Listen for toggle changes from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'extensionToggle') {
    extensionEnabled = request.enabled;
    console.log('Extension toggled:', extensionEnabled);
    
    if (extensionEnabled) {
      // Re-initialize if enabled
      setTimeout(() => {
        processUsernames();
      }, 500);
    } else {
      // Remove all flags if disabled
      removeAllFlags();
    }
  }
});

/**
 * Load location cache from Chrome storage
 * Filters out expired entries and null values
 * @async
 * @returns {Promise<void>}
 */
async function loadCache() {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache load');
      return;
    }

    const result = await chrome.storage.local.get(CONFIG.CACHE.KEY);
    if (result[CONFIG.CACHE.KEY]) {
      const cached = result[CONFIG.CACHE.KEY];
      const now = Date.now();

      // Filter out expired entries and null entries (allow retry)
      for (const [username, data] of Object.entries(cached)) {
        if (data.expiry && data.expiry > now && data.location !== null) {
          locationCache.set(username, data.location);
        }
      }
      console.log(`Loaded ${locationCache.size} cached locations (excluding null entries)`);
    }
  } catch (error) {
    // Extension context invalidated errors are expected when extension is reloaded
    if (error.message?.includes('Extension context invalidated') ||
        error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache load skipped');
    } else {
      console.error('Error loading cache:', error);
    }
  }
}

/**
 * Save location cache to Chrome storage with expiry timestamps
 * @async
 * @returns {Promise<void>}
 */
async function saveCache() {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache save');
      return;
    }

    const cacheObj = {};
    const now = Date.now();
    const expiry = now + (CONFIG.CACHE.EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    for (const [username, location] of locationCache.entries()) {
      cacheObj[username] = {
        location: location,
        expiry: expiry,
        cachedAt: now
      };
    }

    await chrome.storage.local.set({ [CONFIG.CACHE.KEY]: cacheObj });
  } catch (error) {
    // Extension context invalidated errors are expected when extension is reloaded
    if (error.message?.includes('Extension context invalidated') ||
        error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache save skipped');
    } else {
      console.error('Error saving cache:', error);
    }
  }
}

/**
 * Save a single cache entry with debouncing
 * @async
 * @param {string} username - Twitter username
 * @param {string|null} location - User location or null if not found
 * @returns {Promise<void>}
 */
async function saveCacheEntry(username, location) {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Extension context invalidated, skipping cache entry save');
    return;
  }
  
  locationCache.set(username, location);
  // Debounce saves
  if (!saveCache.timeout) {
    saveCache.timeout = setTimeout(async () => {
      await saveCache();
      saveCache.timeout = null;
    }, CONFIG.CACHE.SAVE_DEBOUNCE_MS);
  }
}

/**
 * Inject page script into the page context to intercept Twitter API headers
 * and make authenticated API requests
 * @returns {void}
 */
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('pageScript.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  
  // Listen for rate limit info from page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__rateLimitInfo') {
      rateLimitResetTime = event.data.resetTime;
      const waitTime = event.data.waitTime;
      console.log(`Rate limit detected. Will resume requests in ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }
  });
}

/**
 * Process the request queue with rate limiting and concurrency control
 * Respects MIN_REQUEST_INTERVAL_MS and MAX_CONCURRENT_REQUESTS
 * @async
 * @returns {Promise<void>}
 */
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }
  
  // Check if we're rate limited
  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;
      console.log(`Rate limited. Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes...`);
      setTimeout(processRequestQueue, Math.min(waitTime, 60000)); // Check every minute max
      return;
    } else {
      // Rate limit expired, reset
      rateLimitResetTime = 0;
    }
  }
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0 && activeRequests < CONFIG.RATE_LIMIT.MAX_CONCURRENT_REQUESTS) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    // Wait if needed to respect rate limit
    if (timeSinceLastRequest < CONFIG.RATE_LIMIT.MIN_REQUEST_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest));
    }
    
    const { screenName, resolve, reject } = requestQueue.shift();
    activeRequests++;
    lastRequestTime = Date.now();
    
    // Make the request
    makeLocationRequest(screenName)
      .then(location => {
        resolve(location);
      })
      .catch(error => {
        reject(error);
      })
      .finally(() => {
        activeRequests--;
        // Continue processing queue
        setTimeout(processRequestQueue, 200);
      });
  }
  
  isProcessingQueue = false;
}

/**
 * Make an API request for a user's location via page script
 * @param {string} screenName - Twitter username
 * @returns {Promise<string|null>} Location string or null
 */
function makeLocationRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();
    
    // Listen for response via postMessage
    const handler = (event) => {
      // Only accept messages from the page (not from extension)
      if (event.source !== window) return;
      
      if (event.data && 
          event.data.type === '__locationResponse' &&
          event.data.screenName === screenName && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        const location = event.data.location;
        const isRateLimited = event.data.isRateLimited || false;
        
        // Only cache if not rate limited (don't cache failures due to rate limiting)
        if (!isRateLimited) {
          saveCacheEntry(screenName, location || null);
        } else {
          console.log(`Not caching null for ${screenName} due to rate limit`);
        }
        
        resolve(location || null);
      }
    };
    window.addEventListener('message', handler);
    
    // Send fetch request to page script via postMessage
    window.postMessage({
      type: '__fetchLocation',
      screenName,
      requestId
    }, '*');
    
    // Timeout
    setTimeout(() => {
      window.removeEventListener('message', handler);
      // Don't cache timeout failures - allow retry
      console.log(`Request timeout for ${screenName}, not caching`);
      resolve(null);
    }, CONFIG.API.TIMEOUT);
  });
}

/**
 * Query Twitter GraphQL API for user location with caching and rate limiting
 * @async
 * @param {string} screenName - Twitter username
 * @returns {Promise<string|null>} Location string or null if not found
 */
async function getUserLocation(screenName) {
  // Check cache first
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    // Don't return cached null - retry if it was null before (might have been rate limited)
    if (cached !== null) {
      console.log(`Using cached location for ${screenName}: ${cached}`);
      return cached;
    } else {
      console.log(`Found null in cache for ${screenName}, will retry API call`);
      // Remove from cache to allow retry
      locationCache.delete(screenName);
    }
  }
  
  console.log(`Queueing API request for ${screenName}`);
  // Queue the request
  return new Promise((resolve, reject) => {
    requestQueue.push({ screenName, resolve, reject });
    processRequestQueue();
  });
}

/**
 * Extract Twitter username from various UI elements
 * Handles multiple DOM structures and filters out invalid routes
 * @param {Element} element - DOM element containing username
 * @returns {string|null} Username without @ symbol, or null if not found
 */
function extractUsername(element) {
  // Try data-testid="UserName" or "User-Name" first (most reliable)
  const usernameElement = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1];
        // Filter out common routes
        if (!CONFIG.USERNAME.EXCLUDED_ROUTES.includes(username) &&
            !username.startsWith('hashtag') &&
            !username.startsWith('search') &&
            username.length >= CONFIG.USERNAME.MIN_LENGTH &&
            username.length <= CONFIG.USERNAME.MAX_LENGTH) {
          return username;
        }
      }
    }
  }
  
  // Try finding username links in the entire element (broader search)
  const allLinks = element.querySelectorAll('a[href^="/"]');
  const seenUsernames = new Set();
  
  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;
    
    const match = href.match(/^\/([^\/\?]+)/);
    if (!match || !match[1]) continue;
    
    const potentialUsername = match[1];
    
    // Skip if we've already checked this username
    if (seenUsernames.has(potentialUsername)) continue;
    seenUsernames.add(potentialUsername);
    
    // Filter out routes and invalid usernames
    if (CONFIG.USERNAME.EXCLUDED_ROUTES.some(route => potentialUsername === route || potentialUsername.startsWith(route))) {
      continue;
    }
    
    // Skip status/tweet links
    if (potentialUsername.includes('status') || potentialUsername.match(/^\d+$/)) {
      continue;
    }
    
    // Check link text/content for username indicators
    const text = link.textContent?.trim() || '';
    const linkText = text.toLowerCase();
    const usernameLower = potentialUsername.toLowerCase();
    
    // If link text starts with @, it's definitely a username
    if (text.startsWith('@')) {
      return potentialUsername;
    }
    
    // If link text matches the username (without @), it's likely a username
    if (linkText === usernameLower || linkText === `@${usernameLower}`) {
      return potentialUsername;
    }
    
    // Check if link is in a UserName container or has username-like structure
    const parent = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
    if (parent) {
      // If it's in a UserName container and looks like a username, return it
      if (potentialUsername.length >= CONFIG.USERNAME.MIN_LENGTH &&
          potentialUsername.length <= CONFIG.USERNAME.MAX_LENGTH &&
          !potentialUsername.includes('/')) {
        return potentialUsername;
      }
    }
    
    // Also check if link text is @username format
    if (text && text.trim().startsWith('@')) {
      const atUsername = text.trim().substring(1);
      if (atUsername === potentialUsername) {
        return potentialUsername;
      }
    }
  }
  
  // Last resort: look for @username pattern in text content and verify with link
  const textContent = element.textContent || '';
  const atMentionMatches = textContent.matchAll(/@([a-zA-Z0-9_]+)/g);
  for (const match of atMentionMatches) {
    const username = match[1];
    // Verify it's actually a link in a User-Name container
    const link = element.querySelector(`a[href="/${username}"], a[href^="/${username}?"]`);
    if (link) {
      // Make sure it's in a username context, not just mentioned in tweet text
      const isInUserNameContainer = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
      if (isInUserNameContainer) {
        return username;
      }
    }
  }
  
  return null;
}

/**
 * Find the DOM element containing the @username handle
 * @param {Element} container - Parent container element
 * @param {string} screenName - Twitter username
 * @returns {Element|undefined} Handle section element or undefined
 */
function findHandleSection(container, screenName) {
  return Array.from(container.querySelectorAll('div')).find(div => {
    const link = div.querySelector(`a[href="/${screenName}"]`);
    if (link) {
      const text = link.textContent?.trim();
      return text === `@${screenName}`;
    }
    return false;
  });
}

/**
 * Create a loading shimmer placeholder element
 * @returns {HTMLSpanElement} Shimmer span element
 */
function createLoadingShimmer() {
  const shimmer = document.createElement('span');
  shimmer.setAttribute(SELECTORS.FLAG_SHIMMER_ATTR, 'true');
  shimmer.style.display = 'inline-block';
  shimmer.style.width = CONFIG.UI.SHIMMER_WIDTH;
  shimmer.style.height = CONFIG.UI.SHIMMER_HEIGHT;
  shimmer.style.marginLeft = CONFIG.UI.FLAG_MARGIN_LEFT;
  shimmer.style.marginRight = CONFIG.UI.FLAG_MARGIN_RIGHT;
  shimmer.style.verticalAlign = CONFIG.UI.FLAG_VERTICAL_ALIGN;
  shimmer.style.borderRadius = CONFIG.UI.SHIMMER_BORDER_RADIUS;
  shimmer.style.background = 'linear-gradient(90deg, rgba(113, 118, 123, 0.2) 25%, rgba(113, 118, 123, 0.4) 50%, rgba(113, 118, 123, 0.2) 75%)';
  shimmer.style.backgroundSize = '200% 100%';
  shimmer.style.animation = `shimmer ${CONFIG.UI.SHIMMER_ANIMATION_DURATION} infinite`;

  // Add animation keyframes if not already added
  if (!document.getElementById(SELECTORS.SHIMMER_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = SELECTORS.SHIMMER_STYLE_ID;
    style.textContent = `
      @keyframes shimmer {
        0% {
          background-position: -200% 0;
        }
        100% {
          background-position: 200% 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  return shimmer;
}

/**
 * Add country flag emoji to a username element
 * Fetches location, finds country flag, and inserts it in the appropriate position
 * @async
 * @param {Element} usernameElement - DOM element containing the username
 * @param {string} screenName - Twitter username
 * @returns {Promise<void>}
 */
async function addFlagToUsername(usernameElement, screenName) {
  // Check if flag already added
  if (usernameElement.dataset.flagAdded === 'true') {
    return;
  }

  // Check if this username is already being processed (prevent duplicate API calls)
  if (processingUsernames.has(screenName)) {
    // Wait a bit and check if flag was added by the other process
    await new Promise(resolve => setTimeout(resolve, CONFIG.PROCESSING.DUPLICATE_CHECK_DELAY_MS));
    if (usernameElement.dataset.flagAdded === 'true') {
      return;
    }
    // If still not added, mark this container as waiting
    usernameElement.dataset.flagAdded = 'waiting';
    return;
  }

  // Mark as processing to avoid duplicate requests
  usernameElement.dataset.flagAdded = 'processing';
  processingUsernames.add(screenName);
  
  // Find User-Name container for shimmer placement
  const userNameContainer = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  // Create and insert loading shimmer
  const shimmerSpan = createLoadingShimmer();
  let shimmerInserted = false;
  
  if (userNameContainer) {
    // Try to insert shimmer before handle section (same place flag will go)
    const handleSection = findHandleSection(userNameContainer, screenName);
    if (handleSection && handleSection.parentNode) {
      try {
        handleSection.parentNode.insertBefore(shimmerSpan, handleSection);
        shimmerInserted = true;
      } catch (e) {
        // Fallback: insert at end of container
        try {
          userNameContainer.appendChild(shimmerSpan);
          shimmerInserted = true;
        } catch (e2) {
          console.log('Failed to insert shimmer');
        }
      }
    } else {
      // Fallback: insert at end of container
      try {
        userNameContainer.appendChild(shimmerSpan);
        shimmerInserted = true;
      } catch (e) {
        console.log('Failed to insert shimmer');
      }
    }
  }
  
  try {
    console.log(`Processing flag for ${screenName}...`);

    // Get location
    const location = await getUserLocation(screenName);
    console.log(`Location for ${screenName}:`, location);
    
    // Remove shimmer
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    
    if (!location) {
      console.log(`No location found for ${screenName}, marking as failed`);
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

  // Get flag emoji
  const flag = getCountryFlag(location);
  if (!flag) {
    console.log(`No flag found for location: ${location}`);
    // Shimmer already removed above, but ensure it's gone
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found flag ${flag} for ${screenName} (${location})`);

  // Find the username link - try multiple strategies
  // Priority: Find the @username link, not the display name link
  let usernameLink = null;
  
  // Find the User-Name container (reuse from above if available, otherwise find it)
  const containerForLink = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  // Strategy 1: Find link with @username text content (most reliable - this is the actual handle)
  if (containerForLink) {
    const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
    for (const link of containerLinks) {
      const text = link.textContent?.trim();
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      
      // Prioritize links that have @username as text
      if (match && match[1] === screenName) {
        if (text === `@${screenName}` || text === screenName) {
          usernameLink = link;
          break;
        }
      }
    }
  }
  
  // Strategy 2: Find any link with @username text in UserName container
  if (!usernameLink && containerForLink) {
    const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
    for (const link of containerLinks) {
      const text = link.textContent?.trim();
      if (text === `@${screenName}`) {
        usernameLink = link;
        break;
      }
    }
  }
  
  // Strategy 3: Find link with exact matching href that has @username text anywhere in element
  if (!usernameLink) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();
      if ((href === `/${screenName}` || href.startsWith(`/${screenName}?`)) && 
          (text === `@${screenName}` || text === screenName)) {
        usernameLink = link;
        break;
      }
    }
  }
  
  // Strategy 4: Fallback to any matching href (but prefer ones not in display name area)
  if (!usernameLink) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1] === screenName) {
        // Skip if this looks like a display name link (has verification badge nearby)
        const hasVerificationBadge = link.closest('[data-testid="User-Name"]')?.querySelector('[data-testid="icon-verified"]');
        if (!hasVerificationBadge || link.textContent?.trim() === `@${screenName}`) {
          usernameLink = link;
          break;
        }
      }
    }
  }

  if (!usernameLink) {
    console.error(`Could not find username link for ${screenName}`);
    console.error('Available links in container:', Array.from(usernameElement.querySelectorAll('a[href^="/"]')).map(l => ({
      href: l.getAttribute('href'),
      text: l.textContent?.trim()
    })));
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  console.log(`Found username link for ${screenName}:`, usernameLink.href, usernameLink.textContent?.trim());

  // Check if flag already exists (check in the entire container, not just parent)
  const existingFlag = usernameElement.querySelector(`[${SELECTORS.FLAG_ATTR}]`);
  if (existingFlag) {
    // Remove shimmer if flag already exists
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'true';
    return;
  }

  // Add flag emoji - place it next to verification badge, before @ handle
  const flagSpan = document.createElement('span');
  flagSpan.textContent = ` ${flag}`;
  flagSpan.setAttribute(SELECTORS.FLAG_ATTR, 'true');
  flagSpan.style.marginLeft = CONFIG.UI.FLAG_MARGIN_LEFT;
  flagSpan.style.marginRight = CONFIG.UI.FLAG_MARGIN_RIGHT;
  flagSpan.style.display = CONFIG.UI.FLAG_DISPLAY;
  flagSpan.style.color = 'inherit';
  flagSpan.style.verticalAlign = CONFIG.UI.FLAG_VERTICAL_ALIGN;
  
  // Use userNameContainer found above, or find it if not found
  const containerForFlag = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  
  if (!containerForFlag) {
    console.error(`Could not find UserName container for ${screenName}`);
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }
  
  // Find the verification badge (SVG with data-testid="icon-verified")
  const verificationBadge = containerForFlag.querySelector('[data-testid="icon-verified"]');
  
  // Find the handle section - the div that contains the @username link
  // The structure is: User-Name > div (display name) > div (handle section with @username)
  const handleSection = findHandleSection(containerForFlag, screenName);

  let inserted = false;
  
  // Strategy 1: Insert right before the handle section div (which contains @username)
  // The handle section is a direct child of User-Name container
  if (handleSection && handleSection.parentNode === containerForFlag) {
    try {
      containerForFlag.insertBefore(flagSpan, handleSection);
      inserted = true;
      console.log(`✓ Inserted flag before handle section for ${screenName}`);
    } catch (e) {
      console.log('Failed to insert before handle section:', e);
    }
  }
  
  // Strategy 2: Find the handle section's parent and insert before it
  if (!inserted && handleSection && handleSection.parentNode) {
    try {
      // Insert before the handle section's parent (if it's not User-Name)
      const handleParent = handleSection.parentNode;
      if (handleParent !== containerForFlag && handleParent.parentNode) {
        handleParent.parentNode.insertBefore(flagSpan, handleParent);
        inserted = true;
        console.log(`✓ Inserted flag before handle parent for ${screenName}`);
      } else if (handleParent === containerForFlag) {
        // Handle section is direct child, insert before it
        containerForFlag.insertBefore(flagSpan, handleSection);
        inserted = true;
        console.log(`✓ Inserted flag before handle section (direct child) for ${screenName}`);
      }
    } catch (e) {
      console.log('Failed to insert before handle parent:', e);
    }
  }
  
  // Strategy 3: Find display name container and insert after it, before handle section
  if (!inserted && handleSection) {
    try {
      // Find the display name link (first link)
      const displayNameLink = containerForFlag.querySelector('a[href^="/"]');
      if (displayNameLink) {
        // Find the div that contains the display name link
        const displayNameContainer = displayNameLink.closest('div');
        if (displayNameContainer && displayNameContainer.parentNode) {
          // Check if handle section is a sibling
          if (displayNameContainer.parentNode === handleSection.parentNode) {
            displayNameContainer.parentNode.insertBefore(flagSpan, handleSection);
            inserted = true;
            console.log(`✓ Inserted flag between display name and handle (siblings) for ${screenName}`);
          } else {
            // Try inserting after display name container
            displayNameContainer.parentNode.insertBefore(flagSpan, displayNameContainer.nextSibling);
            inserted = true;
            console.log(`✓ Inserted flag after display name container for ${screenName}`);
          }
        }
      }
    } catch (e) {
      console.log('Failed to insert after display name:', e);
    }
  }
  
  // Strategy 4: Insert at the end of User-Name container (fallback)
  if (!inserted) {
    try {
      containerForFlag.appendChild(flagSpan);
      inserted = true;
      console.log(`✓ Inserted flag at end of UserName container for ${screenName}`);
    } catch (e) {
      console.error('Failed to append flag to User-Name container:', e);
    }
  }
  
    if (inserted) {
      // Mark as processed
      usernameElement.dataset.flagAdded = 'true';
      console.log(`✓ Successfully added flag ${flag} for ${screenName} (${location})`);
      
      // Also mark any other containers waiting for this username
      const waitingContainers = document.querySelectorAll(`[data-flag-added="waiting"]`);
      waitingContainers.forEach(container => {
        const waitingUsername = extractUsername(container);
        if (waitingUsername === screenName) {
          // Try to add flag to this container too
          addFlagToUsername(container, screenName).catch(() => {});
        }
      });
    } else {
      console.error(`✗ Failed to insert flag for ${screenName} - tried all strategies`);
      console.error('Username link:', usernameLink);
      console.error('Parent structure:', usernameLink.parentNode);
      // Remove shimmer on failure
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'failed';
    }
  } catch (error) {
    console.error(`Error processing flag for ${screenName}:`, error);
    // Remove shimmer on error
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
  } finally {
    // Remove from processing set
    processingUsernames.delete(screenName);
  }
}

/**
 * Remove all flags and shimmers from the page
 * Called when extension is disabled
 * @returns {void}
 */
function removeAllFlags() {
  const flags = document.querySelectorAll(`[${SELECTORS.FLAG_ATTR}]`);
  flags.forEach(flag => flag.remove());

  // Also remove any loading shimmers
  const shimmers = document.querySelectorAll(`[${SELECTORS.FLAG_SHIMMER_ATTR}]`);
  shimmers.forEach(shimmer => shimmer.remove());

  // Reset flag added markers
  const containers = document.querySelectorAll(`[${SELECTORS.FLAG_ADDED_ATTR}]`);
  containers.forEach(container => {
    delete container.dataset.flagAdded;
  });

  console.log('Removed all flags');
}

/**
 * Process all username elements on the page and add flags
 * Scans for tweet containers, user cells, and username elements
 * @async
 * @returns {Promise<void>}
 */
async function processUsernames() {
  // Check if extension is enabled
  if (!extensionEnabled) {
    return;
  }
  
  // Find all tweet/article containers and user cells
  const containers = document.querySelectorAll(`${SELECTORS.TWEET}, ${SELECTORS.USER_CELL}, ${SELECTORS.USER_NAMES}, ${SELECTORS.USER_NAME}`);
  
  console.log(`Processing ${containers.length} containers for usernames`);
  
  let foundCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  
  for (const container of containers) {
    const screenName = extractUsername(container);
    if (screenName) {
      foundCount++;
      const status = container.dataset.flagAdded;
      if (!status || status === 'failed') {
        processedCount++;
        // Process in parallel but limit concurrency
        addFlagToUsername(container, screenName).catch(err => {
          console.error(`Error processing ${screenName}:`, err);
          container.dataset.flagAdded = 'failed';
        });
      } else {
        skippedCount++;
      }
    } else {
      // Debug: log containers that don't have usernames
      const hasUserName = container.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
      if (hasUserName) {
        console.log('Found UserName container but no username extracted');
      }
    }
  }
  
  if (foundCount > 0) {
    console.log(`Found ${foundCount} usernames, processing ${processedCount} new ones, skipped ${skippedCount} already processed`);
  } else {
    console.log('No usernames found in containers');
  }
}

/**
 * Initialize MutationObserver to watch for dynamically loaded content
 * Processes new usernames as they appear (infinite scroll, etc.)
 * @returns {void}
 */
function initContentObserver() {
  if (contentObserver) {
    contentObserver.disconnect();
  }

  contentObserver = new MutationObserver((mutations) => {
    // Don't process if extension is disabled
    if (!extensionEnabled) {
      return;
    }

    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }

    if (shouldProcess) {
      // Debounce processing
      setTimeout(processUsernames, CONFIG.PROCESSING.OBSERVER_DEBOUNCE_MS);
    }
  });

  contentObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/**
 * Initialize MutationObserver to detect SPA navigation
 * Reprocesses usernames when URL changes
 * @returns {void}
 */
function initNavigationObserver() {
  if (navigationObserver) {
    navigationObserver.disconnect();
  }

  let lastUrl = location.href;

  navigationObserver = new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('Page navigation detected, reprocessing usernames');
      setTimeout(processUsernames, CONFIG.PROCESSING.RETRY_ON_NAVIGATION_DELAY_MS);
    }
  });

  navigationObserver.observe(document, {
    subtree: true,
    childList: true
  });
}

/**
 * Disconnect and cleanup all MutationObservers
 * @returns {void}
 */
function cleanupObservers() {
  if (contentObserver) {
    contentObserver.disconnect();
    contentObserver = null;
  }
  if (navigationObserver) {
    navigationObserver.disconnect();
    navigationObserver = null;
  }
}

/**
 * Main initialization function
 * Loads state and cache, injects page script, sets up observers
 * @async
 * @returns {Promise<void>}
 */
async function init() {
  console.log('Twitter Location Flag extension initialized');
  
  // Load enabled state first
  await loadEnabledState();
  
  // Load persistent cache
  await loadCache();
  
  // Only proceed if extension is enabled
  if (!extensionEnabled) {
    console.log('Extension is disabled');
    return;
  }
  
  // Inject page script
  injectPageScript();
  
  // Wait a bit for page to fully load
  setTimeout(() => {
    processUsernames();
  }, CONFIG.PROCESSING.INITIAL_DELAY_MS);

  // Set up observers for new content and navigation
  initContentObserver();
  initNavigationObserver();

  // Save cache periodically
  setInterval(saveCache, CONFIG.CACHE.PERIODIC_SAVE_INTERVAL_MS);
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  cleanupObservers();
});

// Wait for page to load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

