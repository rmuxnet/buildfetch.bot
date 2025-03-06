import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
import requests
from datetime import datetime

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Welcome to AxionAOSP Build Checker!\n"
        "Use /axion <codename> to check latest builds\n"
        "Example: /axion a71"
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
        
        message = f"Builds available for {codename.upper()}:\n"
        if vanilla_data:
            message += f"\nVanilla: {vanilla_data['version']}"
        if gms_data:
            message += f"\nGMS: {gms_data['version']}"
        
        await update.message.reply_text(message, reply_markup=reply_markup)

    except Exception as e:
        logger.error(f"Error: {e}")
        await update.message.reply_text("Failed to fetch build information. Please try again later.")

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
    
    message = (
        f"📱 {codename.upper()} {variant} Build\n\n"
        f"🔖 Version: {build_data['version']}\n"
        f"📅 Date: {build_data['date']}\n"
        f"📦 Size: {build_data['size']}\n"
        f"📁 File: {build_data['filename']}\n\n"
        f"🔗 Download: {build_data['url']}"
    )
    
    await query.edit_message_text(text=message)

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
    application = Application.builder().token("GAYFATHER_TOKEN").build()
    
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("axion", axion_command))
    application.add_handler(CallbackQueryHandler(button_callback))
    
    application.run_polling()

if __name__ == '__main__':
    main()
