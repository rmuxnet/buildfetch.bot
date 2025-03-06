import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
import requests
from datetime import datetime
import re

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Store devices and maintainers globally to avoid fetching on every request
DEVICES_DATA = None
MAINTAINERS_DATA = None
LAST_FETCH_TIME = None

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Welcome to Axion Build Checker!\n"
        "Use /axion <codename> to check latest builds\n"
        "Example: /axion pipa\n\n"
        "Use /devices to see all officially supported devices"
    )

async def axion_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    codename = context.args[0].lower() if context.args else None
    if not codename:
        await update.message.reply_text("Please provide a device codename!\nExample: /axion a71")
        return

    try:
        # Try to fetch both variants
        vanilla_data = fetch_build_data(codename, "VANILLA")
        gms_data = fetch_build_data(codename, "GMS")
        
        if not vanilla_data and not gms_data:
            await update.message.reply_text(f"No builds found for {codename}!")
            return

        # Prepare buttons
        keyboard = []
        if vanilla_data:
            keyboard.append([InlineKeyboardButton("Vanilla", callback_data=f"vanilla_{codename}")])
        if gms_data:
            keyboard.append([InlineKeyboardButton("GMS", callback_data=f"gms_{codename}")])
        
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        message = f"Builds available for *{codename.upper()}*:\n"
        if vanilla_data:
            message += f"\n• *Vanilla:* {vanilla_data['version']}"
        if gms_data:
            message += f"\n• *GMS:* {gms_data['version']}"
        
        await update.message.reply_text(
            message, 
            reply_markup=reply_markup,
            parse_mode='Markdown'
        )

    except Exception as e:
        logger.error(f"Error: {e}")
        await update.message.reply_text("Failed to fetch build information. Please try again later.")

async def devices_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        # Fetch devices and maintainers data
        devices, maintainers = fetch_devices_and_maintainers()
        
        if not devices:
            await update.message.reply_text("Failed to fetch device information. Please try again later.")
            return
        
        # Create message with device list
        message = "*📱 Official AxionAOSP Devices:*\n\n"
        
        sorted_devices = sorted(devices.items(), key=lambda x: x[1])  # Sort by device name
        
        for codename, device_name in sorted_devices:
            message += f"• *{device_name}* (`{codename}`)"
            
            # Find maintainer for this device
            device_maintainer = None
            for m_name, m_devices in maintainers.items():
                if codename in m_devices:
                    device_maintainer = m_name
                    break
            
            if device_maintainer:
                message += f" - Maintained by {device_maintainer}\n"
            else:
                message += "\n"
                
        # Split message if it's too long (Telegram has 4096 character limit)
        if len(message) > 4000:
            chunks = [message[i:i+4000] for i in range(0, len(message), 4000)]
            for chunk in chunks:
                await update.message.reply_text(
                    chunk,
                    parse_mode='Markdown',
                    disable_web_page_preview=True
                )
        else:
            await update.message.reply_text(
                message,
                parse_mode='Markdown',
                disable_web_page_preview=True
            )
            
    except Exception as e:
        logger.error(f"Error in devices command: {e}")
        await update.message.reply_text("Failed to fetch device information. Please try again later.")

def fetch_devices_and_maintainers():
    global DEVICES_DATA, MAINTAINERS_DATA, LAST_FETCH_TIME
    
    # Check if we already have data that's not too old (refresh every hour)
    current_time = datetime.now()
    if DEVICES_DATA and MAINTAINERS_DATA and LAST_FETCH_TIME and \
       (current_time - LAST_FETCH_TIME).total_seconds() < 3600:
        return DEVICES_DATA, MAINTAINERS_DATA
    
    # Fetch README from GitHub
    url = "https://raw.githubusercontent.com/AxionAOSP/official_devices/main/README.md"
    response = requests.get(url)
    
    if response.status_code != 200:
        logger.error(f"Failed to fetch README: {response.status_code}")
        return None, None
    
    content = response.text
    
    # Parse devices table
    devices_section = re.search(r'# 📱 Supported Devices\s+\|[^\n]+\|[^\n]+\|(.*?)(?=\n\n|\n##)', content, re.DOTALL)
    if not devices_section:
        logger.error("Could not find devices section in README")
        return {}, {}
    
    devices_table = devices_section.group(1)
    devices = {}
    
    for line in devices_table.strip().split('\n'):
        match = re.search(r'\|\s*\*\*(.*?)\*\*\s*\|\s*`(.*?)`\s*\|', line)
        if match:
            device_name = match.group(1).strip()
            codename = match.group(2).strip()
            devices[codename] = device_name
    
    # Parse maintainers section
    maintainers_section = re.search(r'## 👤 Maintainers(.*?)(?=\n\n|\n##|$)', content, re.DOTALL)
    if not maintainers_section:
        logger.error("Could not find maintainers section in README")
        return devices, {}
    
    maintainers_list = maintainers_section.group(1)
    maintainers = {}
    
    for line in maintainers_list.strip().split('\n'):
        match = re.search(r'- \*\*\[(.*?)\].*?\*\* \((.*?)\)', line)
        if match:
            maintainer_name = match.group(1).strip()
            devices_text = match.group(2).strip()
            
            # Extract device codenames from the maintainer line
            maintainer_devices = []
            for device in devices.keys():
                if device.lower() in devices_text.lower():
                    maintainer_devices.append(device)
            
            maintainers[maintainer_name] = maintainer_devices
    
    # Update global variables
    DEVICES_DATA = devices
    MAINTAINERS_DATA = maintainers
    LAST_FETCH_TIME = current_time
    
    return devices, maintainers

def fetch_build_data(codename, variant):
    url = f"https://raw.githubusercontent.com/AxionAOSP/official_devices/main/OTA/{variant}/{codename}.json"
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        if data['response']:
            latest_build = data['response'][0]
            return {
                "filename": latest_build['filename'],
                "version": latest_build['version'],
                "size": human_readable_size(latest_build['size']),
                "date": format_timestamp(latest_build['datetime']),
                "url": latest_build['url'],
                "variant": variant
            }
    return None

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data = query.data
    variant, codename = data.split('_')
    variant = variant.upper()
    
    build_data = fetch_build_data(codename, variant)
    if not build_data:
        await query.edit_message_text(text=f"No {variant} build found for {codename}!")
        return
    
    # Create a cleaner message without showing the raw URL
    message = (
        f"📱 *{codename.upper()} ({variant})*\n\n"
        f"🔖 *Version:* {build_data['version']}\n"
        f"📅 *Date:* {build_data['date']}\n"
        f"📦 *Size:* {build_data['size']}"
    )
    
    # Create download button
    keyboard = [
        [InlineKeyboardButton("⬇️ Download", url=build_data['url'])],
        [InlineKeyboardButton("🔙 Back", callback_data=f"back_{codename}")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    # Send the improved message with markdown formatting
    await query.edit_message_text(
        text=message,
        reply_markup=reply_markup,
        parse_mode='Markdown'
    )

async def back_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    codename = query.data.split('_')[1]
    
    # Fetch both variants again
    vanilla_data = fetch_build_data(codename, "VANILLA")
    gms_data = fetch_build_data(codename, "GMS")
    
    # Prepare buttons
    keyboard = []
    if vanilla_data:
        keyboard.append([InlineKeyboardButton("Vanilla", callback_data=f"vanilla_{codename}")])
    if gms_data:
        keyboard.append([InlineKeyboardButton("GMS", callback_data=f"gms_{codename}")])
    
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    message = f"Builds available for *{codename.upper()}*:\n"
    if vanilla_data:
        message += f"\n• *Vanilla:* {vanilla_data['version']}"
    if gms_data:
        message += f"\n• *GMS:* {gms_data['version']}"
    
    await query.edit_message_text(
        text=message,
        reply_markup=reply_markup,
        parse_mode='Markdown'
    )

def human_readable_size(size_bytes):
    if size_bytes == 0:
        return "0B"
    units = ('B', 'KB', 'MB', 'GB', 'TB')
    i = 0
    while size_bytes >= 1024 and i < len(units)-1:
        size_bytes /= 1024
        i += 1
    return f"{size_bytes:.2f} {units[i]}"

def format_timestamp(timestamp):
    return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')

def main():
    application = Application.builder().token("7978344885:AAHv8F9gPm1WuyetYSOG_kIgum5cwdmYwUU").build()
    
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("axion", axion_command))
    application.add_handler(CommandHandler("devices", devices_command))
    
    # Add pattern matching for callback handlers
    application.add_handler(CallbackQueryHandler(button_callback, pattern=r"^(vanilla|gms)_"))
    application.add_handler(CallbackQueryHandler(back_button, pattern=r"^back_"))
    
    application.run_polling()

if __name__ == '__main__':
    main()
