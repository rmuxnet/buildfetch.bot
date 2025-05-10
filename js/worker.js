const TELEGRAM_TOKEN = 'EHMN';
const API_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DEVICES_URL = 'https://raw.githubusercontent.com/AxionAOSP/official_devices/main/dinfo.json';
const BUILD_DATA_URL = 'https://raw.githubusercontent.com/AxionAOSP/official_devices/main/OTA';
const CACHE_TTL = 60; // Cache for 1 min
const ADMIN_CHAT_ID = '5578239588'; // Your chat ID for error logs
const GITHUB_ENDPOINTS = {
  devices: DEVICES_URL,
  vanillaOTA: `${BUILD_DATA_URL}/VANILLA/a71.json`, // Test endpoint with known device
  gmsOTA: `${BUILD_DATA_URL}/GMS/a71.json` // Test endpoint with known device
};

// In-memory cache
let devicesCache = null;
let maintainersCache = null;
let supportGroupsCache = null;
let imageUrlsCache = null;
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

// Function to clear cache
function clearCache() {
  devicesCache = null;
  maintainersCache = null;
  supportGroupsCache = null;
  imageUrlsCache = null;
  devicesCacheTime = 0;
  buildDataCache = {};
  addLog("Cache cleared manually");
  return "Cache cleared successfully";
}

// Function to report errors to admin
async function reportErrorToAdmin(context, error, additionalInfo = '') {
  try {
    const errorMsg = `⚠️ *Bot Error Report*\n\n` +
                     `*Context:* ${context}\n` +
                     `*Error:* ${error.message || String(error)}\n` +
                     `*Stack:* ${error.stack ? error.stack.substring(0, 500) + '...' : 'N/A'}\n` +
                     (additionalInfo ? `\n*Additional Info:*\n${additionalInfo}` : '');
    
    // Log error in console and logs array
    addLog(`ERROR REPORT - ${context}: ${error.message || String(error)}`);
    
    // Send to admin chat
    const params = new URLSearchParams({
      chat_id: ADMIN_CHAT_ID,
      text: errorMsg,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    await fetch(`${API_BASE}/sendMessage?${params}`);
  } catch (reportError) {
    // Just log to console if error reporting itself fails
    console.error(`Failed to report error to admin: ${reportError}`);
    addLog(`Failed to report error to admin: ${reportError}`);
  }
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
  
  // Clear cache endpoint
  if (url.pathname === '/clearcache' && request.method === 'GET') {
    const result = clearCache();
    return new Response(result, { status: 200 });
  }
  
  if (request.method === 'POST') {
    try {
      const update = await request.json();
      addLog(`Received update: ${JSON.stringify(update).substring(0, 100)}...`);
      return handleUpdate(update);
    } catch (error) {
      await reportErrorToAdmin('handleRequest', error);
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
      else if (baseCommand === '/refresh' && chatId.toString() === ADMIN_CHAT_ID) {
        // Admin-only command to refresh cache
        clearCache();
        return sendMessage(chatId, "Cache refreshed successfully!");
      }
      else if (baseCommand === '/debug' && args[1] && chatId.toString() === ADMIN_CHAT_ID) {
        try {
          const codename = args[1]?.toLowerCase();
          const variant = args[2]?.toUpperCase() || 'VANILLA';
          
          // Force refresh cache
          clearCache();
          
          // Fetch build data directly
          const buildData = await fetchBuildData(codename, variant, true);
          
          if (!buildData) {
            return sendMessage(chatId, `No ${variant} build found for ${codename}!`);
          }
          
          let debugInfo = `DEBUG INFO for ${codename} (${variant}):\n\n`;
          debugInfo += JSON.stringify(buildData, null, 2);
          
          return sendMessage(chatId, debugInfo);
        } catch (error) {
          await reportErrorToAdmin('Debug command', error);
          return sendMessage(chatId, `Debug error: ${error.message}`);
        }
      }
      else if (baseCommand === '/checkbuild' && args[1] && chatId.toString() === ADMIN_CHAT_ID) {
        const codename = args[1].toLowerCase();
        return checkBuildExistence(chatId, codename);
      }
      else if (baseCommand === '/testcon' && chatId.toString() === ADMIN_CHAT_ID) {
        // New command to test GitHub connectivity
        return testGitHubConnectivity(chatId);
      }
      else if (command === '!gh') {
        return testGitHubConnectivity(chatId);
      } else if (command === '!info') {
        return sendInfo(chatId);
      } else if (command === '!logs') {
        return sendLogs(chatId);
      } else if (command === '!stats') {
        return sendStats(chatId);
      } else if (command === '!status') {
        return sendStatus(chatId);
      }
    }

    return new Response('OK');
  } catch (error) {
    await reportErrorToAdmin('handleUpdate', error, `Update: ${JSON.stringify(update).substring(0, 300)}...`);
    addLog(`Error handling update: ${error}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function testGitHubConnectivity(chatId) {
  addLog(`GitHub connectivity test requested by ${chatId}`);
  const timestamp = new Date().toLocaleString();
  let message = `🔄 *Testing GitHub Connectivity*\n\n🕒 *Timestamp:* ${timestamp}\n\n`;

  try {
    const results = {};
    for (const [name, url] of Object.entries(GITHUB_ENDPOINTS)) {
      try {
        const startTime = Date.now();
        const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
        const endTime = Date.now();
        const responseTime = endTime - startTime;

        if (response.ok) {
          results[name] = { status: response.status, time: responseTime, success: true };
          message += `✅ *${name}:* Success! Status: ${response.status}, Response Time: ${responseTime}ms\n`;
        } else {
          results[name] = { status: response.status, time: responseTime, success: false };
          message += `❌ *${name}:* Failed! Status: ${response.status}, Response Time: ${responseTime}ms\n`;
        }
      } catch (error) {
        results[name] = { error: error.message, success: false };
        message += `❌ *${name}:* Error: ${error.message}\n`;
      }
    }

    const allSuccessful = Object.values(results).every(r => r.success);
    message += allSuccessful ? '\n✅ *All connections successful!*' : '\n⚠️ *Some connections failed.*';

    return sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await reportErrorToAdmin('testGitHubConnectivity', error);
    return sendMessage(chatId, `Error testing connectivity: ${error.message}`);
  }
}

async function sendInfo(chatId) {
  addLog(`Info command requested by ${chatId}`);
  const timestamp = new Date().toLocaleString();
  try {
    const [devices, maintainers, supportGroups] = await fetchDevicesData();
    const vanillaBuilds = Object.keys(buildDataCache).filter(key => key.includes('_VANILLA')).length;
    const gmsBuilds = Object.keys(buildDataCache).filter(key => key.includes('_GMS')).length;

    const message = 
      `📊 *Bot Info*\n\n` +
      `🕒 *Timestamp:* ${timestamp}\n` +
      `📱 *Devices fetched:* ${Object.keys(devices).length}\n` +
      `👤 *Maintainers fetched:* ${Object.keys(maintainers).length}\n` +
      `💬 *Support groups fetched:* ${Object.keys(supportGroups).length}\n` +
      `📦 *OTA Builds:*\n` +
      `   • *Vanilla:* ${vanillaBuilds} builds available\n` +
      `   • *GMS:* ${gmsBuilds} builds available\n\n` +
      `🕒 *Cache last refreshed:* ${new Date(devicesCacheTime).toLocaleString()}\n\n` +
      `Use /devices to see the full list of supported devices.`;

    return sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await reportErrorToAdmin('sendInfo', error);
    addLog(`Error in info command: ${error}`);
    return sendMessage(chatId, "Failed to fetch bot info. Please try again later.");
  }
}

async function sendLogs(chatId) {
  addLog(`Logs command requested by ${chatId}`);
  try {
    // Get the recent logs but format them for better display
    // Instead of escaping markdown, we'll remove markup syntax and format it differently
    const logs = logMessages.slice(0, 10).map(log => {
      // Remove timestamp brackets for cleaner display
      let cleanLog = log.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/g, '');
      // Remove any markdown formatting completely rather than escaping it
      cleanLog = cleanLog.replace(/[*_`]/g, '');
      return `○ ${cleanLog.trim()}`;
    }).join('\n\n');
    
    const message = "📝 *Recent Logs*\n━━━━━━━━━━━━━━━━━\n\n" + logs;
    
    // Send without markdown formatting to avoid parsing issues
    return sendMessage(chatId, message, { 
      parse_mode: '', // No parse mode to avoid formatting issues
      disable_web_page_preview: true
    });
  } catch (error) {
    await reportErrorToAdmin('sendLogs', error);
    addLog(`Error in logs command: ${error}`);
    return sendMessage(chatId, "Failed to fetch logs. Please try again later.");
  }
}

async function sendStats(chatId) {
  addLog(`Stats command requested by ${chatId}`);
  try {
    // Replace process.uptime() and process.memoryUsage() with mock data or alternatives
    const uptimeMinutes = Math.floor((Date.now() - performance.timeOrigin) / 60000); // Approximate uptime
    const memoryUsage = {
      rss: 50 * 1024 * 1024, // Mock RSS memory usage (50 MB)
      heapUsed: 30 * 1024 * 1024, // Mock heap used (30 MB)
      heapTotal: 40 * 1024 * 1024 // Mock heap total (40 MB)
    };

    const message = 
      `📊 *Bot Stats*\n\n` +
      `🕒 *Uptime:* ${uptimeMinutes} minutes\n` +
      `💾 *Memory Usage:*\n` +
      `   • RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB\n` +
      `   • Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB\n` +
      `   • Heap Total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB\n\n` +
      `Use !info for more details.`;

    return sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await reportErrorToAdmin('sendStats', error);
    addLog(`Error in stats command: ${error}`);
    return sendMessage(chatId, "Failed to fetch stats. Please try again later.");
  }
}

async function sendStatus(chatId) {
  addLog(`Status command requested by ${chatId}`);
  try {
    const [devices, maintainers] = await fetchDevicesData();
    const vanillaBuilds = Object.keys(buildDataCache).filter(key => key.includes('_VANILLA')).length;
    const gmsBuilds = Object.keys(buildDataCache).filter(key => key.includes('_GMS')).length;

    const message = 
      `✅ *Bot Status*\n\n` +
      `📱 *Devices fetched:* ${Object.keys(devices).length}\n` +
      `📦 *OTA Builds:*\n` +
      `   • *Vanilla:* ${vanillaBuilds} builds available\n` +
      `   • *GMS:* ${gmsBuilds} builds available\n` +
      `🕒 *Cache last refreshed:* ${new Date(devicesCacheTime).toLocaleString()}\n\n` +
      `Use !info for more details.`;

    return sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await reportErrorToAdmin('sendStatus', error);
    addLog(`Error in status command: ${error}`);
    return sendMessage(chatId, "Failed to fetch status. Please try again later.");
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
    addLog(`Direct build check for ${codename}`);
    const directVanillaData = await fetchBuildData(codename, 'VANILLA', true);
    const directGmsData = await fetchBuildData(codename, 'GMS', true);
    
    if (directVanillaData || directGmsData) {
      addLog(`Found direct build data for ${codename}`);
      
      let [devices, maintainers, supportGroups, imageUrls] = await fetchDevicesData(true);
      
      if (!devices[codename]) {
        addLog(`Device ${codename} has builds but isn't in the devices list - adding temporary entry`);
        const displayName = codename.charAt(0).toUpperCase() + codename.slice(1);
        devices[codename] = displayName;
        devicesCache = devices;
      }
      
      const deviceName = devices[codename];
      const maintainer = maintainers[codename] || 'Not specified';
      const keyboard = [];
      
      let message = `📱 *${deviceName}* (${codename})\n`;
      if (maintainer) message += `👤 Maintainer: ${maintainer}\n\n`;
      message += "*Available builds:*\n";

      if (directVanillaData) {
        keyboard.push([{ text: "Vanilla", callback_data: `vanilla_${codename}` }]);
        message += `\n• Vanilla: ${directVanillaData.version}`;
      }
      if (directGmsData) {
        keyboard.push([{ text: "GMS", callback_data: `gms_${codename}` }]);
        message += `\n• GMS: ${directGmsData.version}`;
      }

      addLog(`Sending build info for ${codename} to ${chatId}`);
      return sendMessage(chatId, message, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }
    
    addLog(`No direct builds found for ${codename}, checking device list`);
    const [devices, maintainers] = await fetchDevicesData(true);
    
    let foundCodename = devices[codename] ? codename : null;
    
    if (!foundCodename) {
      const lowercaseInput = codename.toLowerCase();
      
      for (const deviceCodename in devices) {
        if (deviceCodename.toLowerCase() === lowercaseInput) {
          foundCodename = deviceCodename;
          break;
        }
      }
    }
    
    if (!foundCodename) {
      const lowercaseInput = codename.toLowerCase();
      const similarCodenames = Object.keys(devices)
        .filter(device => 
          device.toLowerCase().includes(lowercaseInput) || 
          lowercaseInput.includes(device.toLowerCase())
        )
        .slice(0, 3);
      
      let message = `Device "${codename}" not found in official devices list and no builds exist.`;
      if (similarCodenames.length > 0) {
        message += `\n\nDid you mean:\n${similarCodenames.map(c => `• ${c} (${devices[c]})`).join('\n')}`;
      }
      
      addLog(`Device ${codename} not found and no builds exist, suggesting ${similarCodenames.join(', ')}`);
      return sendMessage(chatId, message);
    }
    
    addLog(`Device ${foundCodename} found in list, checking builds for correct case`);
    const vanillaData = await fetchBuildData(foundCodename, 'VANILLA', true);
    const gmsData = await fetchBuildData(foundCodename, 'GMS', true);
    
    if (!vanillaData && !gmsData) {
      addLog(`No builds found for ${foundCodename}`);
      return sendMessage(chatId, `No builds found for ${foundCodename}!`);
    }
    
    const deviceName = devices[foundCodename];
    const maintainer = maintainers[foundCodename] || 'Not specified';
    const keyboard = [];
    
    let message = `📱 *${deviceName}* (${foundCodename})\n`;
    if (maintainer) message += `👤 Maintainer: ${maintainer}\n\n`;
    message += "*Available builds:*\n";

    if (vanillaData) {
      keyboard.push([{ text: "Vanilla", callback_data: `vanilla_${foundCodename}` }]);
      message += `\n• Vanilla: ${vanillaData.version}`;
    }
    if (gmsData) {
      keyboard.push([{ text: "GMS", callback_data: `gms_${foundCodename}` }]);
      message += `\n• GMS: ${gmsData.version}`;
    }

    addLog(`Sending build info for ${foundCodename} (${deviceName}) to ${chatId}`);
    return sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await reportErrorToAdmin('handleAxionCommand', error, `Codename: ${codename}`);
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
    
    const sortedDevices = Object.entries(devices).sort((a, b) => a[1].localeCompare(b[1]));
    
    const manufacturers = {};
    for (const [codename, name] of sortedDevices) {
      const manufacturer = name.split(' ')[0];
      if (!manufacturers[manufacturer]) {
        manufacturers[manufacturer] = [];
      }
      manufacturers[manufacturer].push({ codename, name });
    }
    
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
    await reportErrorToAdmin('handleDevicesCommand', error);
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
    await reportErrorToAdmin('handleBackButton', error, `Codename: ${codename}`);
    addLog(`Error handling back button: ${error}`);
    return editMessage(query, "Failed to fetch build information. Please try again later.");
  }
}

async function handleBuildDetails(query, variant, codename) {
  addLog(`Build details requested for ${codename} (${variant})`);
  try {
    const [devices, maintainers, supportGroups, imageUrls] = await fetchDevicesData();
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
    
    if (supportGroup) {
      keyboard.unshift([{ text: "💬 Support Group", url: supportGroup }]);
    }
    
    keyboard.push([{ text: "🔙 Back", callback_data: `back_${codename}` }]);

    addLog(`Sending ${variant} build details for ${codename}`);
    return editMessage(query, message, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    await reportErrorToAdmin('handleBuildDetails', error, `Codename: ${codename}, Variant: ${variant}`);
    addLog(`Error fetching build details: ${error}`);
    return editMessage(query, "Failed to fetch build details. Please try again later.");
  }
}

async function fetchDevicesData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && devicesCache && maintainersCache && supportGroupsCache && imageUrlsCache && (now - devicesCacheTime < CACHE_TTL * 1000)) {
    return [devicesCache, maintainersCache, supportGroupsCache, imageUrlsCache];
  }
  
  addLog(`Fetching devices data from GitHub${forceRefresh ? ' (forced refresh)' : ''}`);
  
  try {
    const cacheBuster = `?t=${Date.now()}`;
    const response = await fetch(DEVICES_URL + cacheBuster, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    
    if (!response.ok) {
      const errorMsg = `Failed to fetch devices: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
    }
    
    const data = await response.json();
    
    addLog(`Device data structure check: ${JSON.stringify(data).substring(0, 100)}...`);
    
    const devices = {};
    const maintainers = {};
    const supportGroups = {};
    const imageUrls = {};
    
    if (data.devices && Array.isArray(data.devices)) {
      addLog(`Found ${data.devices.length} devices in JSON data`);
      
      for (const device of data.devices) {
        if (device.codename && device.device_name) {
          devices[device.codename] = device.device_name;
          
          if (device.maintainer) {
            maintainers[device.codename] = device.maintainer;
          }
          
          if (device.support_group) {
            supportGroups[device.codename] = device.support_group;
          }
          
          if (device.image_url) {
            imageUrls[device.codename] = device.image_url;
          }
          
          addLog(`Processed device: ${device.codename} (${device.device_name})`);
        } else {
          addLog(`Skipped invalid device entry: ${JSON.stringify(device).substring(0, 100)}...`);
        }
      }
    } else {
      const errorMsg = 'Invalid device data format - "devices" array not found';
      addLog(`Unexpected JSON structure: ${JSON.stringify(data).substring(0, 200)}...`);
      throw new Error(errorMsg);
    }

    addLog(`Loaded ${Object.keys(devices).length} devices from repository`);
    
    const deviceSample = Object.keys(devices).slice(0, 5).join(', ');
    addLog(`Sample devices: ${deviceSample}`);

    devicesCache = devices;
    maintainersCache = maintainers;
    supportGroupsCache = supportGroups;
    imageUrlsCache = imageUrls;
    devicesCacheTime = now;
    
    return [devices, maintainers, supportGroups, imageUrls];
  } catch (error) {
    await reportErrorToAdmin('fetchDevicesData', error);
    addLog(`Error fetching devices: ${error}`);
    return [{}, {}, {}, {}];
  }
}

async function fetchBuildData(codename, variant, forceRefresh = false) {
  const cacheKey = `${codename}_${variant}`;
  
  const now = Date.now();
  if (!forceRefresh && buildDataCache[cacheKey] && (now - buildDataCache[cacheKey].timestamp < CACHE_TTL * 1000)) {
    return buildDataCache[cacheKey].data;
  }
  
  addLog(`Fetching build data for ${codename} (${variant})${forceRefresh ? ' (forced refresh)' : ''}`);
  
  try {
    const url = `${BUILD_DATA_URL}/${variant}/${codename}.json`;
    const cacheBuster = `?t=${Date.now()}`;
    const fetchUrl = url + cacheBuster;
    
    addLog(`Fetching from URL: ${fetchUrl}`);
    
    const response = await fetch(fetchUrl, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    
    if (!response.ok) {
      addLog(`No build data found for ${codename} (${variant}) - Status: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    addLog(`Build data structure: ${JSON.stringify(data).substring(0, 150)}...`);
    
    if (!data.response || !Array.isArray(data.response) || data.response.length === 0) {
      addLog(`Empty or invalid build data for ${codename} (${variant})`);
      return null;
    }
    
    const latestBuild = data.response[0];
    
    const buildData = {
      filename: latestBuild.filename,
      version: latestBuild.version,
      size: humanReadableSize(latestBuild.size),
      date: formatTimestamp(latestBuild.datetime),
      url: latestBuild.url
    };
    
    addLog(`Found build ${buildData.version} for ${codename} (${variant})`);
    
    buildDataCache[cacheKey] = {
      data: buildData,
      timestamp: now
    };
    
    return buildData;
  } catch (error) {
    await reportErrorToAdmin('fetchBuildData', error, `Codename: ${codename}, Variant: ${variant}`);
    addLog(`Error fetching build data for ${codename} (${variant}): ${error}`);
    return null;
  }
}

async function checkBuildExistence(chatId, codename) {
  try {
    clearCache();
    
    const [devices, maintainers] = await fetchDevicesData(true);
    const deviceExists = devices[codename] ? true : false;
    
    let message = `Debug check for ${codename}:\n\n`;
    message += `✓ Device in official list: ${deviceExists ? 'Yes' : 'No'}\n`;
    
    if (deviceExists) {
      message += `- Device name: ${devices[codename]}\n`;
      message += `- Maintainer: ${maintainers[codename] || 'Not specified'}\n\n`;
    }
    
    const vanillaUrl = `${BUILD_DATA_URL}/VANILLA/${codename}.json`;
    message += `✓ Checking for Vanilla build: ${vanillaUrl}\n`;
    
    try {
      const vanillaBuild = await fetchBuildData(codename, 'VANILLA', true);
      if (vanillaBuild) {
        message += `- Found! Version: ${vanillaBuild.version}\n`;
        message += `- Filename: ${vanillaBuild.filename}\n`;
        message += `- Size: ${vanillaBuild.size}\n`;
      } else {
        message += `- No Vanilla build found\n`;
      }
    } catch (error) {
      message += `- Error: ${error.message}\n`;
    }
    
    message += '\n';
    
    const gmsUrl = `${BUILD_DATA_URL}/GMS/${codename}.json`;
    message += `✓ Checking for GMS build: ${gmsUrl}\n`;
    
    try {
      const gmsBuild = await fetchBuildData(codename, 'GMS', true);
      if (gmsBuild) {
        message += `- Found! Version: ${gmsBuild.version}\n`;
        message += `- Filename: ${gmsBuild.filename}\n`;
        message += `- Size: ${gmsBuild.size}\n`;
      } else {
        message += `- No GMS build found\n`;
      }
    } catch (error) {
      message += `- Error: ${error.message}\n`;
    }
    
    await sendMessage(chatId, message);
  } catch (error) {
    await reportErrorToAdmin('checkBuildExistence', error, `Codename: ${codename}`);
    await sendMessage(chatId, `Error checking build existence: ${error.message}`);
  }
}

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
    await reportErrorToAdmin('answerCallbackQuery', error);
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
      
      // If there's a parsing error with Markdown, try sending without formatting
      if (errorData.description && (
          errorData.description.includes("can't parse entities") || 
          errorData.description.includes("message is too long"))) {
        
        if (options.parse_mode) {
          addLog(`Retrying without parse mode due to formatting error`);
          // Clone options but remove parse_mode
          const plainOptions = {...options};
          delete plainOptions.parse_mode;
          return sendMessage(chatId, text, plainOptions);
        }
        
        // If message is too long, split it
        if (errorData.description.includes("message is too long")) {
          const maxLength = 4000;
          for (let i = 0; i < text.length; i += maxLength) {
            const chunk = text.substring(i, i + maxLength);
            await sendMessage(chatId, chunk, {
              disable_web_page_preview: true
            });
          }
          return new Response('OK');
        }
      }
    }
    
    return new Response('OK');
  } catch (error) {
    await reportErrorToAdmin('sendMessage', error, `Chat ID: ${chatId}, Text: ${text}`);
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
    await reportErrorToAdmin('editMessage', error, `Query: ${JSON.stringify(query).substring(0, 300)}...`);
    addLog(`Error editing message: ${error}`);
    return new Response('Failed to edit message', { status: 500 });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
