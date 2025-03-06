const TELEGRAM_TOKEN = 'mreow';
const API_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DEVICES_URL = 'https://raw.githubusercontent.com/AxionAOSP/official_devices/main/README.md';
const BUILD_DATA_URL = 'https://raw.githubusercontent.com/AxionAOSP/official_devices/main/OTA';
const CACHE_TTL = 60; // Cache for 1 min

// In-memory cache
let devicesCache = null;
let maintainersCache = null;
let devicesCacheTime = 0;
let buildDataCache = {};

async function handleRequest(request) {
    if (request.method === 'POST') {
        try {
            const update = await request.json();
            return handleUpdate(update);
        } catch (error) {
            console.error('Error parsing request:', error);
            return new Response('Bad Request', { status: 400 });
        }
    }
    return new Response('This webhook only accepts POST requests.', { status: 200 });
}

async function handleUpdate(update) {
    try {
        if (update.callback_query) {
            await answerCallbackQuery(update.callback_query.id);
            const data = update.callback_query.data;
            const [action, codename] = data.split('_');
            
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
        console.error('Error handling update:', error);
        return new Response('Internal Server Error', { status: 500 });
    }
}

async function sendStart(chatId) {
    return sendMessage(chatId,
        "Welcome to Axion Build Checker!\n" +
        "Use /axion <codename> to check latest builds\n" +
        "Example: /axion pipa\n\n" +
        "Use /devices to see all officially supported devices"
    );
}

async function sendHelp(chatId) {
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
        return sendMessage(chatId, "Please provide a device codename!\nExample: /axion a71");
    }

    try {
        const [devices, maintainers] = await fetchDevicesAndMaintainers();
        
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
            
            return sendMessage(chatId, message);
        }
        
        const [vanillaData, gmsData] = await Promise.all([
            fetchBuildData(codename, 'VANILLA'),
            fetchBuildData(codename, 'GMS')
        ]);

        if (!vanillaData && !gmsData) {
            return sendMessage(chatId, `No builds found for ${codename}!`);
        }

        const deviceName = devices[codename];
        const maintainer = getMaintainerForDevice(maintainers, codename, devices);
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

        return sendMessage(chatId, message, {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Error:', error);
        return sendMessage(chatId, "Failed to fetch build information. Please try again later.");
    }
}

async function handleDevicesCommand(chatId) {
    try {
        const [devices, maintainers] = await fetchDevicesAndMaintainers();
        
        if (Object.keys(devices).length === 0) {
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
        console.error('Error:', error);
        return sendMessage(chatId, "Failed to fetch device information. Please try again later.");
    }
}

async function handleBackButton(query, codename) {
    try {
        const [devices, maintainers] = await fetchDevicesAndMaintainers();
        const [vanillaData, gmsData] = await Promise.all([
            fetchBuildData(codename, 'VANILLA'),
            fetchBuildData(codename, 'GMS')
        ]);

        const deviceName = devices[codename];
        const maintainer = getMaintainerForDevice(maintainers, codename, devices);
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
        console.error('Error:', error);
        return editMessage(query, "Failed to fetch build information. Please try again later.");
    }
}

async function handleBuildDetails(query, variant, codename) {
    try {
        const [devices, maintainers] = await fetchDevicesAndMaintainers();
        const buildData = await fetchBuildData(codename, variant.toUpperCase());
        
        if (!buildData) {
            return editMessage(query, `No ${variant} build found for ${codename}!`);
        }

        const deviceName = devices[codename];
        const maintainer = getMaintainerForDevice(maintainers, codename, devices);
        
        const message = 
            `⚡ *${variant.toUpperCase()} Build*\n` +
            `📱 Device: ${deviceName} (${codename})\n` +
            `👤 Maintainer: ${maintainer || 'Not specified'}\n\n` +
            `🔖 Version: ${buildData.version}\n` +
            `📅 Date: ${buildData.date}\n` +
            `📦 Size: ${buildData.size}`;

        const keyboard = [
            [{ text: "⬇️ Download", url: buildData.url }]
        ];
        
        // Add MD5 button if available
        if (buildData.md5) {
            keyboard.push([{ text: "📋 MD5: " + buildData.md5.substring(0, 16) + "...", callback_data: "md5_copy" }]);
        }
        
        keyboard.push([{ text: "🔙 Back", callback_data: `back_${codename}` }]);

        return editMessage(query, message, {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Error:', error);
        return editMessage(query, "Failed to fetch build details. Please try again later.");
    }
}

async function fetchDevicesAndMaintainers() {
    // Check cache first
    const now = Date.now();
    if (devicesCache && maintainersCache && (now - devicesCacheTime < CACHE_TTL * 1000)) {
        return [devicesCache, maintainersCache];
    }
    
    try {
        const response = await fetch(DEVICES_URL, {
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch devices: ${response.status} ${response.statusText}`);
        }
        
        const content = await response.text();

        // Parse devices
        const devices = {};
        const devicesSection = content.match(/# 📱 Supported Devices\s+\|[^\n]+\|[^\n]+\|((.*?)(?=\n\n|\n##))/s);
        if (devicesSection) {
            for (const row of devicesSection[1].trim().split('\n')) {
                const match = row.match(/\|\s*\*\*(.*?)\*\*\s*\|\s*`(.*?)`\s*\|/);
                if (match) {
                    const deviceName = match[1].trim();
                    const codename = match[2].trim().toLowerCase();
                    devices[codename] = deviceName;
                }
            }
        }

        // Parse maintainers with device and codename associations
        const maintainersMap = {};
        const maintainersSection = content.match(/## 👤 Maintainers\s+((.*?)(?=\n##|$))/s);
        if (maintainersSection) {
            for (const line of maintainersSection[1].trim().split('\n')) {
                const match = line.match(/-\s+\*\*\[(.*?)\].*?\*\*\s+\((.*?)\)/);
                if (match) {
                    const maintainerName = match[1].trim();
                    const devicesText = match[2];
                    
                    // Extract each individual device from the comma-separated list
                    const devicesList = devicesText.split(',').map(d => d.trim());
                    maintainersMap[maintainerName] = devicesList;
                }
            }
        }

        // Update cache
        devicesCache = devices;
        maintainersCache = maintainersMap;
        devicesCacheTime = now;
        
        return [devices, maintainersMap];
    } catch (error) {
        console.error('Fetch error:', error);
        // Return empty objects if fetch fails but don't update cache
        return [{}, {}];
    }
}

function getMaintainerForDevice(maintainers, codename, devices) {
    const deviceName = devices[codename];
    if (!deviceName) return null;
    
    // Try to find the maintainer by matching the device name or codename
    for (const [maintainer, devicesList] of Object.entries(maintainers)) {
        for (const device of devicesList) {
            // Check if device name matches exactly
            if (device.toLowerCase() === deviceName.toLowerCase()) {
                return maintainer;
            }
            
            // Check if device name contains the device name
            if (device.toLowerCase().includes(deviceName.toLowerCase()) || 
                deviceName.toLowerCase().includes(device.toLowerCase())) {
                return maintainer;
            }
            
            // Check if the device entry has this specific codename
            if (device.toLowerCase().includes(codename.toLowerCase())) {
                return maintainer;
            }
        }
    }
    
    // Try more aggressive matching - check if any part of the device name matches
    // This is useful for devices like "POCO F6 PRO" where maintainer might be listed as "POCO F6 PRO"
    // or just "F6 PRO" or even just "F6"
    const deviceParts = deviceName.toLowerCase().split(' ');
    for (const [maintainer, devicesList] of Object.entries(maintainers)) {
        for (const device of devicesList) {
            for (const part of deviceParts) {
                if (part.length > 1 && device.toLowerCase().includes(part)) {
                    return maintainer;
                }
            }
        }
    }
    
    return null;
}

async function fetchBuildData(codename, variant) {
    // Create cache key
    const cacheKey = `${codename}_${variant}`;
    
    // Check cache first
    const now = Date.now();
    if (buildDataCache[cacheKey] && (now - buildDataCache[cacheKey].timestamp < CACHE_TTL * 1000)) {
        return buildDataCache[cacheKey].data;
    }
    
    try {
        // Fetch actual build data from GitHub OTA repository
        const url = `${BUILD_DATA_URL}/${variant}/${codename}.json`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.log(`No build data for ${codename} (${variant})`);
            return null;
        }
        
        const data = await response.json();
        
        if (!data.response || data.response.length === 0) {
            console.log(`Empty build data for ${codename} (${variant})`);
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
        
        // Update cache
        buildDataCache[cacheKey] = {
            data: buildData,
            timestamp: now
        };
        
        return buildData;
    } catch (error) {
        console.error(`Error fetching build data for ${codename} (${variant}):`, error);
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
        console.error('Error answering callback query:', error);
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
            console.error('Telegram API error:', errorData);
            
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
        console.error('Error sending message:', error);
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
            console.error('Telegram API error:', errorData);
        }
        
        return new Response('OK');
    } catch (error) {
        console.error('Error editing message:', error);
        return new Response('Failed to edit message', { status: 500 });
    }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
