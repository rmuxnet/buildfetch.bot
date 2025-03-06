const TELEGRAM_TOKEN = 'TG_BOT_TOKEN';
const API_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DEVICES_URL = 'https://raw.githubusercontent.com/rmuxnet/buildfetch.bot/refs/heads/main/info/devices.json';
const BUILD_DATA_URL = 'https://raw.githubusercontent.com/AxionAOSP/official_devices/main/OTA';
const CACHE_TTL = 60; // Cache for 1 min

// In-memory cache
let devicesCache = null;
let maintainersCache = null;
let supportGroupsCache = null;
let devicesCacheTime = 0;
let buildDataCache = {};
let logMessages = []; // Store log messages

// Function to add logs
function addLog(message) {
  const timestamp = new Date().toISOString();
  logMessages.unshift(`[${timestamp}] ${message}`); // Add new logs at the beginning
  
  // Keep only the last 100 logs to prevent memory issues
  if (logMessages.length > 100) {
    logMessages = logMessages.slice(0, 100);
  }
  
  console.log(`[${timestamp}] ${message}`);
}

async function handleRequest(request) {
  const url = new URL(request.url);
  
  // Serve HTML page for the root path
  if (url.pathname === '/' && request.method === 'GET') {
    return serveHtmlPage();
  }
  
  // Serve logs as JSON
  if (url.pathname === '/logs' && request.method === 'GET') {
    return new Response(JSON.stringify(logMessages), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (request.method === 'POST') {
    try {
      const update = await request.json();
      addLog(`Received update: ${JSON.stringify(update).substring(0, 100)}...`);
      return handleUpdate(update);
    } catch (error) {
      addLog(`Error parsing request: ${error}`);
      return new Response('Bad Request', { status: 400 });
    }
  }
  
  return new Response('This webhook accepts POST requests for Telegram updates or GET for viewing logs.', { status: 200 });
}

function serveHtmlPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Bot Information</title>
      <style>
          body {
              margin: 0;
              padding: 0;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              background: #1a1a1a;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
  
          .container {
              text-align: center;
              padding: 2rem;
              background: rgba(255, 255, 255, 0.05);
              border-radius: 12px;
              backdrop-filter: blur(10px);
          }
  
          .bot-image {
              width: 200px;
              height: 200px;
              border-radius: 16px;
              margin-bottom: 1.5rem;
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
          }
  
          .credits {
              color: #ffffff;
              font-size: 1.1rem;
              margin-top: 1rem;
              opacity: 0.9;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <img src="https://bluemoji.io/cdn-proxy/646218c67da47160c64a84d5/66b3ea6b437be789ded213fd_45.png" 
               alt="Bot Logo" 
               class="bot-image">
          <div class="credits">
              Bot by: rmux (@mx7111)
          </div>
      </div>
  </body>
  </html>
  `;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

async function handleUpdate(update) {
  try {
    if (update.callback_query) {
      await answerCallbackQuery(update.callback_query.id);
      const data = update.callback_query.data;
      const [action, codename] = data.split('_');
      
      addLog(`Callback query: ${action} for device ${codename}`);
      
      if (action === 'back') {
        return handleBackButton(update.callback_query, codename);
      }
      return handleBuildDetails(update.callback_query, action, codename);
    }

    if (update.message && update.message.text) {
      const message = update.message.text;
      const chatId = update.message.chat.id;
      const chatType = update.message.chat.type || 'private';
      const args = message.split(/\s+/);
      const command = args[0].toLowerCase();
      
      addLog(`Received message: ${message} from chat ${chatId}`);

      // Extract the base command without bot username
      let baseCommand = command;
      if (command.includes('@')) {
        const [cmd, botUsername] = command.split('@');
        baseCommand = cmd;
      }

      if (baseCommand === '/start') {
        return sendStart(chatId);
      }
      else if (baseCommand === '/axion') {
        const codename = args[1]?.toLowerCase();
        return handleAxionCommand(chatId, codename);
      }
      else if (baseCommand === '/devices') {
        return handleDevicesCommand(chatId);
      }
      else if (baseCommand === '/help') {
        return sendHelp(chatId);
      }
    }

    return new Response('OK');
  } catch (error) {
    addLog(`Error handling update: ${error}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function sendStart(chatId) {
  addLog(`Sending start message to ${chatId}`);
  return sendMessage(chatId,
    "Welcome to Axion Build Checker!\n" +
    "Use /axion <codename> to check latest builds\n" +
    "Example: /axion pipa\n\n" +
    "Use /devices to see all officially supported devices"
  );
}

async function sendHelp(chatId) {
  addLog(`Sending help message to ${chatId}`);
  return sendMessage(chatId,
    "📱 *Axion Build Checker Commands:*\n\n" +
    "/start - Start the bot\n" +
    "/axion <codename> - Check builds for a specific device\n" +
    "/devices - List all officially supported devices\n" +
    "/help - Show this help message",
    { parse_mode: 'Markdown' }
  );
}

async function handleAxionCommand(chatId, codename) {
  if (!codename) {
    addLog(`Axion command used without codename by ${chatId}`);
    return sendMessage(chatId, "Please provide a device codename!\nExample: /axion pipa");
  }

  addLog(`Checking builds for ${codename} requested by ${chatId}`);
  
  try {
    const [devices, maintainers, supportGroups] = await fetchDevicesData();
    
    // Check if device exists in official list
    if (!devices[codename]) {
      // Try to find similar codenames for suggestion
      const similarCodenames = Object.keys(devices)
        .filter(device => device.includes(codename) || codename.includes(device))
        .slice(0, 3);
      
      let message = `Device "${codename}" not found in official devices list.`;
      if (similarCodenames.length > 0) {
        message += `\n\nDid you mean:\n${similarCodenames.map(c => `• ${c} (${devices[c]})`).join('\n')}`;
      }
      
      addLog(`Device ${codename} not found, suggesting ${similarCodenames.join(', ')}`);
      return sendMessage(chatId, message);
    }
    
    const [vanillaData, gmsData] = await Promise.all([
      fetchBuildData(codename, 'VANILLA'),
      fetchBuildData(codename, 'GMS')
    ]);

    if (!vanillaData && !gmsData) {
      addLog(`No builds found for ${codename}`);
      return sendMessage(chatId, `No builds found for ${codename}!`);
    }

    const deviceName = devices[codename];
    const maintainer = maintainers[codename] || 'Not specified';
    const keyboard = [];
    
    let message = `📱 *${deviceName}* (${codename})\n`;
    if (maintainer) message += `👤 Maintainer: ${maintainer}\n\n`;
    message += "*Available builds:*\n";

    if (vanillaData) {
      keyboard.push([{ text: "Vanilla", callback_data: `vanilla_${codename}` }]);
      message += `\n• Vanilla: ${vanillaData.version}`;
    }
    if (gmsData) {
      keyboard.push([{ text: "GMS", callback_data: `gms_${codename}` }]);
      message += `\n• GMS: ${gmsData.version}`;
    }

    addLog(`Sending build info for ${codename} (${deviceName}) to ${chatId}`);
    return sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    addLog(`Error in axion command: ${error}`);
    return sendMessage(chatId, "Failed to fetch build information. Please try again later.");
  }
}

async function handleDevicesCommand(chatId) {
  addLog(`Devices command requested by ${chatId}`);
  try {
    const [devices, maintainers] = await fetchDevicesData();
    
    if (Object.keys(devices).length === 0) {
      addLog('No devices found in the repository');
      return sendMessage(chatId, "No devices found. Please try again later.");
    }
    
    // Sort devices by name
    const sortedDevices = Object.entries(devices).sort((a, b) => a[1].localeCompare(b[1]));
    
    // Group devices by manufacturer
    const manufacturers = {};
    for (const [codename, name] of sortedDevices) {
      // Extract manufacturer from device name (usually the first word)
      const manufacturer = name.split(' ')[0];
      if (!manufacturers[manufacturer]) {
        manufacturers[manufacturer] = [];
      }
      manufacturers[manufacturer].push({ codename, name });
    }
    
    // Create message with manufacturers and devices
    let message = "📱 *Officially Supported Devices*\n\n";
    
    for (const [manufacturer, deviceList] of Object.entries(manufacturers)) {
      message += `*${manufacturer}*\n`;
      for (const device of deviceList) {
        message += `• ${device.name} (\`${device.codename}\`)\n`;
      }
      message += '\n';
    }
    
    message += "Use /axion <codename> to check builds for a specific device";
    
    addLog(`Sending device list with ${Object.keys(devices).length} devices to ${chatId}`);
    
    // Split message if it's too long (Telegram has 4096 character limit)
    if (message.length > 4000) {
      const chunks = [];
      let currentChunk = '';
      
      const lines = message.split('\n');
      for (const line of lines) {
        if (currentChunk.length + line.length + 1 > 4000) {
          chunks.push(currentChunk);
          currentChunk = line;
        } else {
          currentChunk += (currentChunk ? '\n' : '') + line;
        }
      }
      
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      addLog(`Message split into ${chunks.length} chunks due to length`);
      
      // Send chunks one by one
      for (const chunk of chunks) {
        await sendMessage(chatId, chunk, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
      }
      
      return new Response('OK');
    } else {
      return sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }
  } catch (error) {
    addLog(`Error in devices command: ${error}`);
    return sendMessage(chatId, "Failed to fetch device information. Please try again later.");
  }
}

async function handleBackButton(query, codename) {
  addLog(`Back button pressed for ${codename}`);
  try {
    const [devices, maintainers] = await fetchDevicesData();
    const [vanillaData, gmsData] = await Promise.all([
      fetchBuildData(codename, 'VANILLA'),
      fetchBuildData(codename, 'GMS')
    ]);

    const deviceName = devices[codename];
    const maintainer = maintainers[codename] || 'Not specified';
    const keyboard = [];
    
    let message = `📱 *${deviceName}* (${codename})\n`;
    if (maintainer) message += `👤 Maintainer: ${maintainer}\n\n`;
    message += "*Available builds:*\n";

    if (vanillaData) {
      keyboard.push([{ text: "Vanilla", callback_data: `vanilla_${codename}` }]);
      message += `\n• Vanilla: ${vanillaData.version}`;
    }
    if (gmsData) {
      keyboard.push([{ text: "GMS", callback_data: `gms_${codename}` }]);
      message += `\n• GMS: ${gmsData.version}`;
    }

    return editMessage(query, message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    addLog(`Error handling back button: ${error}`);
    return editMessage(query, "Failed to fetch build information. Please try again later.");
  }
}

async function handleBuildDetails(query, variant, codename) {
  addLog(`Build details requested for ${codename} (${variant})`);
  try {
    const [devices, maintainers, supportGroups] = await fetchDevicesData();
    const buildData = await fetchBuildData(codename, variant.toUpperCase());
    
    if (!buildData) {
      addLog(`No ${variant} build found for ${codename}`);
      return editMessage(query, `No ${variant} build found for ${codename}!`);
    }

    const deviceName = devices[codename];
    const maintainer = maintainers[codename] || 'Not specified';
    const supportGroup = supportGroups[codename] || null;
    
    const message = 
      `⚡ *${variant.toUpperCase()} Build*\n` +
      `📱 Device: ${deviceName} (${codename})\n` +
      `👤 Maintainer: ${maintainer}\n\n` +
      `🔖 Version: ${buildData.version}\n` +
      `📅 Date: ${buildData.date}\n` +
      `📦 Size: ${buildData.size}`;

    const keyboard = [
      [{ text: "⬇️ Download", url: buildData.url }]
    ];
    
    // Add Support Group button if available
    if (supportGroup) {
      keyboard.unshift([{ text: "💬 Support Group", url: supportGroup }]);
    }
    
    // Add MD5 button if available
    if (buildData.md5) {
      keyboard.push([{ text: "📋 MD5: " + buildData.md5.substring(0, 16) + "...", callback_data: "md5_copy" }]);
    }
    
    keyboard.push([{ text: "🔙 Back", callback_data: `back_${codename}` }]);

    addLog(`Sending ${variant} build details for ${codename}`);
    return editMessage(query, message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    addLog(`Error fetching build details: ${error}`);
    return editMessage(query, "Failed to fetch build details. Please try again later.");
  }
}

async function fetchDevicesData() {
  // Check cache first
  const now = Date.now();
  if (devicesCache && maintainersCache && supportGroupsCache && (now - devicesCacheTime < CACHE_TTL * 1000)) {
    return [devicesCache, maintainersCache, supportGroupsCache];
  }
  
  addLog("Fetching devices data from GitHub");
  
  try {
    const response = await fetch(DEVICES_URL, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch devices: ${response.status} ${response.statusText}`);
    }
    
    // Parse JSON data
    const devicesData = await response.json();

    // Create devices, maintainers and support groups maps
    const devices = {};
    const maintainers = {};
    const supportGroups = {};
    
    // Iterate through each device entry in the JSON
    for (const [codename, info] of Object.entries(devicesData)) {
      // Store device name with codename as key
      devices[codename] = info.device_name;
      
      // Store maintainer info with codename as key
      maintainers[codename] = info.maintainer;
      
      // Store support group with codename as key (if available)
      if (info.support_group) {
        supportGroups[codename] = info.support_group;
      }
      
      // Log each device and its codename
      addLog(`${codename}: ${info.device_name}`);
    }

    addLog(`Loaded ${Object.keys(devices).length} devices from repository`);

    // Update cache
    devicesCache = devices;
    maintainersCache = maintainers;
    supportGroupsCache = supportGroups;
    devicesCacheTime = now;
    
    return [devices, maintainers, supportGroups];
  } catch (error) {
    addLog(`Error fetching devices: ${error}`);
    // Return empty objects if fetch fails but don't update cache
    return [{}, {}, {}];
  }
}

async function fetchBuildData(codename, variant) {
  // Create cache key
  const cacheKey = `${codename}_${variant}`;
  
  // Check cache first
  const now = Date.now();
  if (buildDataCache[cacheKey] && (now - buildDataCache[cacheKey].timestamp < CACHE_TTL * 1000)) {
    return buildDataCache[cacheKey].data;
  }
  
  addLog(`Fetching build data for ${codename} (${variant})`);
  
  try {
    // Fetch actual build data from GitHub OTA repository
    const url = `${BUILD_DATA_URL}/${variant}/${codename}.json`;
    const response = await fetch(url);
    
    if (!response.ok) {
      addLog(`No build data for ${codename} (${variant})`);
      return null;
    }
    
    const data = await response.json();
    
    if (!data.response || data.response.length === 0) {
      addLog(`Empty build data for ${codename} (${variant})`);
      return null;
    }
    
    // Get the latest build (first in the array)
    const latestBuild = data.response[0];
    
    // Format build data
    const buildData = {
      filename: latestBuild.filename,
      version: latestBuild.version,
      size: humanReadableSize(latestBuild.size),
      date: formatTimestamp(latestBuild.datetime),
      url: latestBuild.url,
      md5: latestBuild.md5sum || null
    };
    
    addLog(`Found build ${buildData.version} for ${codename} (${variant})`);
    
    // Update cache
    buildDataCache[cacheKey] = {
      data: buildData,
      timestamp: now
    };
    
    return buildData;
  } catch (error) {
    addLog(`Error fetching build data for ${codename} (${variant}): ${error}`);
    return null;
  }
}

// Helper functions
function humanReadableSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function formatTimestamp(timestamp) {
  return new Date(timestamp * 1000).toISOString().replace(/T/, ' ').replace(/\..+/, '');
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    const params = new URLSearchParams({
      callback_query_id: callbackQueryId,
      text: text
    });

    await fetch(`${API_BASE}/answerCallbackQuery?${params}`);
  } catch (error) {
    addLog(`Error answering callback query: ${error}`);
  }
}

async function sendMessage(chatId, text, options = {}) {
  try {
    const params = new URLSearchParams({
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || '',
      disable_web_page_preview: options.disable_web_page_preview || false
    });

    if (options.reply_markup) {
      params.append('reply_markup', JSON.stringify(options.reply_markup));
    }

    const response = await fetch(`${API_BASE}/sendMessage?${params}`);
    
    if (!response.ok) {
      const errorData = await response.json();
      addLog(`Telegram API error: ${JSON.stringify(errorData)}`);
      
      // If message is too long, try to handle it
      if (errorData.description && errorData.description.includes('message is too long')) {
        // Split the message and send in chunks
        const maxLength = 4000; // Safe limit for Telegram
        for (let i = 0; i < text.length; i += maxLength) {
          const chunk = text.substring(i, i + maxLength);
          await sendMessage(chatId, chunk, {
            parse_mode: options.parse_mode,
            disable_web_page_preview: true
          });
        }
        return new Response('OK');
      }
    }
    
    return new Response('OK');
  } catch (error) {
    addLog(`Error sending message: ${error}`);
    return new Response('Failed to send message', { status: 500 });
  }
}

async function editMessage(query, text, options = {}) {
  try {
    const params = new URLSearchParams({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text,
      parse_mode: options.parse_mode || ''
    });

    if (options.reply_markup) {
      params.append('reply_markup', JSON.stringify(options.reply_markup));
    }

    const response = await fetch(`${API_BASE}/editMessageText?${params}`);
    
    if (!response.ok) {
      const errorData = await response.json();
      addLog(`Telegram API error (edit message): ${JSON.stringify(errorData)}`);
    }
    
    return new Response('OK');
  } catch (error) {
    addLog(`Error editing message: ${error}`);
    return new Response('Failed to edit message', { status: 500 });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
