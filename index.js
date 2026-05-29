import 'dotenv/config'; 
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http'; 
import axios from 'axios'; 
import NodeCache from 'node-cache';

// 🌐 Web Server for Railway
const server = http.createServer((req, res) => {
    res.end('RV Games Ultra Bot is Online!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server is running on port ${PORT}`);
});

const authFolder = './bot_session';
const tempFolder = './temp'; // 📂 තාවකාලික ෆයිල් සඳහා වෙනම ෆෝල්ඩර් එකක්
const activeTasks = new Map(); 
const msgRetryCounterCache = new NodeCache();
const fgStates = new Map(); // 🎮 FitGirl පියවරවල් ට්‍රැක් කිරීමට ස්ටේට් මැප් එකක්

// ෆෝල්ඩර්ස් කලින්ම සාදා ගැනීම
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });

// 📂 Session ID Setup
function setupSession() {
    const credsPath = path.join(authFolder, 'creds.json');
    if (fs.existsSync(credsPath)) return console.log("📂 පැරණි සෙෂන් දත්ත සොයාගන්නා ලදී...");

    const sessionId = process.env.SESSION_ID;
    if (!sessionId) {
        console.error("❌ ERROR: Railway Variables වල SESSION_ID එක දමා නැත!");
        process.exit(1);
    }
    
    fs.mkdirSync(authFolder, { recursive: true });
    try {
        let base64String = sessionId;
        if (sessionId.includes(';;;')) base64String = sessionId.split(';;;').pop();
        else if (sessionId.includes('~')) base64String = sessionId.split('~').pop();
        else if (sessionId.includes(':')) base64String = sessionId.split(':').pop();

        const decrypted = Buffer.from(base64String, 'base64').toString('utf-8');
        JSON.parse(decrypted); 
        fs.writeFileSync(credsPath, decrypted);
        console.log("✅ SESSION_ID එක සාර්ථකව ක්‍රියාත්මක කරන ලදී!");
    } catch (err) {
        console.error("❌ ERROR: SESSION_ID එකේ දෝෂයක් පවතී!");
        process.exit(1); 
    }
}
setupSession();

function getProgressBar(percent) {
    const total = 10;
    const filled = Math.round((percent / 100) * total);
    const empty = total - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

function getExtensionFromMime(mimeType) {
    const map = {
        'application/zip': '.zip',
        'application/x-zip-compressed': '.zip',
        'application/x-rar-compressed': '.rar',
        'application/vnd.rar': '.rar',
        'application/x-rar': '.rar',
        'application/pdf': '.pdf',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'video/mp4': '.mp4',
        'audio/mpeg': '.mp3',
        'application/vnd.android.package-archive': '.apk',
        'text/plain': '.txt'
    };
    return map[mimeType] || '.bin';
}

// 📥 Downloader Core (Upgraded to accept customFileName)
async function handleDownloadAndUpload(url, sock, msg, sendToJid, customFileName = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `🔍 𝖱𝖵 𝖦𝖺𝗆𝖾𝗌 Bot ලින්ක් එක පරීක්ෂා කරමින් පවතී...` }, { quoted: msg });
    
    const controller = new AbortController();
    activeTasks.set(chatJid, {
        controller,
        progressMsgKey: progressMsg.key,
        uploadInterval: null,
        tempFilePath: null,
        writer: null,
        stream: null 
    });

    let tempFilePath = '';

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            signal: controller.signal, 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (activeTasks.has(chatJid)) {
            activeTasks.get(chatJid).stream = response.data;
        }

        let fileName = '';
        const contentDisposition = response.headers['content-disposition'];
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (contentDisposition) {
            const utf8Match = contentDisposition.match(/filename\*=\s*UTF-8''([^;\r\n]*)/i);
            if (utf8Match && utf8Match[1]) fileName = decodeURIComponent(utf8Match[1]);
            else {
                const normalMatch = contentDisposition.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
                if (normalMatch && normalMatch[1]) fileName = normalMatch[1];
            }
        }

        if (!fileName) {
            try {
                const urlParts = url.split('/');
                const lastPart = urlParts[urlParts.length - 1];
                const cleanName = lastPart.split('?')[0].split('#')[0];
                if (cleanName && cleanName.includes('.')) fileName = decodeURIComponent(cleanName);
            } catch (e) {}
        }

        if (fileName) fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim(); 
        if (!fileName || fileName.length > 200) fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        if (!fileName.includes('.')) fileName += getExtensionFromMime(contentType);

        // 💡 Custom Name එකක් ආවොත් ඒ නම පාවිච්චි කරනවා
        if (customFileName) fileName = customFileName;

        const totalLength = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedLength = 0;
        let lastUpdateTime = Date.now();

        tempFilePath = path.join(tempFolder, `${Date.now()}_${fileName}`);
        const writer = fs.createWriteStream(tempFilePath);

        if (activeTasks.has(chatJid)) {
            const task = activeTasks.get(chatJid);
            task.tempFilePath = tempFilePath;
            task.writer = writer;
        }

        response.data.on('data', async (chunk) => {
            if (controller.signal.aborted) return;
            downloadedLength += chunk.length;
            const now = Date.now();
            
            if (now - lastUpdateTime > 3000) { 
                lastUpdateTime = now;
                const dlMB = (downloadedLength / (1024 * 1024)).toFixed(1);
                
                if (totalLength) {
                    const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                    const totMB = (totalLength / (1024 * 1024)).toFixed(1);
                    const bar = getProgressBar(percent);
                    const text = `📥 *Downloading:* ${fileName}\n📊 ${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `📥 *Downloading:* ${fileName}\n📦 Downloaded: ${dlMB}MB (Size Unknown)`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                }
            }
        });

        response.data.on('error', (err) => { writer.destroy(); });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            controller.signal.addEventListener('abort', () => {
                writer.destroy();
                reject(new Error('STOPPED'));
            });
        });

        let uploadPercent = 0;
        const totalMB = totalLength ? (totalLength / (1024 * 1024)).toFixed(1) : (downloadedLength / (1024 * 1024)).toFixed(1);

        const uploadInterval = setInterval(async () => {
            if (controller.signal.aborted) { clearInterval(uploadInterval); return; }
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const bar = getProgressBar(uploadPercent);
                const text = `📤 *Uploading:* ${fileName}\n📊 ${bar} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB`;
                await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
            }
        }, 2000);

        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).uploadInterval = uploadInterval;

        await sock.sendMessage(sendToJid, { 
            document: { url: tempFilePath }, 
            mimetype: contentType, 
            fileName: fileName,
            caption: `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`
        });
        
        clearInterval(uploadInterval);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, { text: `🎉 *${fileName}* සාර්ථකව යවන ලදී!\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`, edit: progressMsg.key }).catch(() => {});
        return true; 

    } catch (error) {
        const task = activeTasks.get(chatJid);
        if (task) {
            if (task.uploadInterval) clearInterval(task.uploadInterval);
            if (task.writer) { try { task.writer.destroy(); } catch(e){} }
            if (task.stream) { try { task.stream.destroy(); } catch(e){} }
        }
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }

        if (axios.isCancel(error) || error.message === 'STOPPED' || controller.signal.aborted) {
            activeTasks.delete(chatJid);
            return 'STOPPED'; 
        }

        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ෆයිල් එක ලබා ගැනීමට නොහැකි විය.`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion(); 

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: ['RV Games Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        msgRetryCounterCache
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; 

        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || 
                     msg.message?.videoMessage?.caption || "";
                     
        const isCommand = text.startsWith('.');
        const hasActiveState = fgStates.has(msg.key.remoteJid);

        if (!isCommand && !hasActiveState) return; 

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 
        
        // 🔒 PRIVATE BOT SECURITY CHECK
        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 

        if (!allowedNumbers.includes(senderNumber)) {
            const privateMessage = 
                `🔒 *𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸名𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                `❌ *Sorry, Access Denied!*\n` +
                `ඔබට මෙම බොට්ගේ විධාන (Commands) භාවිතා කිරීමට අවසර නැත.\n\n` +
                `_This bot is restricted to authorized users only._\n\n` +
                `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
            return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
        }
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // 1️⃣ .si Command 
        if (text.startsWith('.si ')) {
            if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // 2️⃣ .sg Command
        else if (text.startsWith('.sg ')) {
            if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });

            let groupName = text.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න.' }, { quoted: msg });
            const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                
                const startTime = Date.now();
                let uploadedCount = 0;
                let wasStopped = false;

                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupGroupJid);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(chatJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.', edit: initialNotify.key });
            }
        }

        // 3️⃣ .stop Command
        else if (text.trim().startsWith('.stop')) { 
            if (activeTasks.has(chatJid)) {
                const task = activeTasks.get(chatJid);
                task.controller.abort();
                if (task.uploadInterval) clearInterval(task.uploadInterval);
                if (task.stream) { try { task.stream.destroy(); } catch(e){} } 
                if (task.writer) { try { task.writer.destroy(); } catch(e){} }

                if (task.progressMsgKey) {
                    const stoppedText = `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                                        `🛑 *Status: Process Stopped!*\n` +
                                        `⚠️ _දත්ත බාගත කිරීම හෝ යැවීම පරිශීලකයා විසින් නවතා දමා ඇත._\n\n` +
                                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                    await sock.sendMessage(chatJid, { text: stoppedText, edit: task.progressMsgKey }).catch(() => {});
                }

                setTimeout(() => {
                    if (task.tempFilePath && fs.existsSync(task.tempFilePath)) {
                        try { fs.unlinkSync(task.tempFilePath); } catch (e) {}
                    }
                }, 1000);

                activeTasks.delete(chatJid);
                await sock.sendMessage(chatJid, { text: '✅ සියලුම සක්‍රීය ඩවුන්ලෝඩ්/අප්ලෝඩ් ක්‍රියාවලීන් නතර කර දත්ත ඉවත් කරන ලදී!' }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, { text: '❌ මේ මොහොතේ කිසිදු ෆයිල් එකක් බාගත වෙමින් පවතින්නේ නැත.' }, { quoted: msg });
            }
        }

        // 4️⃣ .speed Command
        else if (text.trim() === '.speed') {
            const speedNotify = await sock.sendMessage(chatJid, { text: '⚡ RV Games සර්වර් වේගය පරීක්ෂා කරමින් පවතී...' }, { quoted: msg });
            try {
                const pingStart = Date.now();
                await axios.get('https://google.com');
                const pingTime = Date.now() - pingStart;
                
                const dlStart = Date.now();
                await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer' }); 
                const downloadSpeed = (8 / ((Date.now() - dlStart) / 1000)).toFixed(2);
                
                const payload = 'A'.repeat(1048576);
                const ulStart = Date.now();
                await axios.post('https://httpbin.org/post', payload, { headers: { 'Content-Type': 'text/plain' } });
                const uploadSpeed = (8 / ((Date.now() - ulStart) / 1000)).toFixed(2);
                
                const speedText = `*⚡ RV GAMES SERVER SPEED* 🎮\n\n` +
                                  `🏓 *Ping:* \`${pingTime} ms\`\n` +
                                  `📥 *Download Speed:* \`${downloadSpeed} Mbps\`\n` +
                                  `📤 *Upload Speed:* \`${uploadSpeed} Mbps\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, { text: speedText, edit: speedNotify.key });
            } catch (error) {
                await sock.sendMessage(chatJid, { text: `❌ Speed test දෝෂයකි: ${error.message}`, edit: speedNotify.key });
            }
        }

        // 5️⃣ .dc Command (Disk Cleaner)
        else if (text.trim() === '.dc') {
            const dcNotify = await sock.sendMessage(chatJid, { text: '🧹 RV Games සර්වර් එකේ තාවකාලික ෆයිල් ඉවත් කරමින් පවතී...' }, { quoted: msg });
            try {
                const files = fs.readdirSync(tempFolder);
                let deletedCount = 0;
                let freedSpace = 0;

                files.forEach(file => {
                    const filePath = path.join(tempFolder, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isFile()) {
                        freedSpace += stat.size;
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                });

                const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);
                const clearText = `*🧹 RV GAMES DISK CLEANER* ⚙️\n\n` +
                                  `✅ *Status:* Temp Folder Cleaned!\n` +
                                  `🗑️ *Removed Files:* \`${deletedCount} files\`\n` +
                                  `📦 *Freed Space:* \`${freedMB} MB\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, { text: clearText, edit: dcNotify.key });
            } catch (error) {
                await sock.sendMessage(chatJid, { text: `❌ Disk එක Clear කිරීමේදී දෝෂයක් ඇති විය.`, edit: dcNotify.key });
            }
        }
        
        // 6️⃣ .crash Command
        else if (text.trim() === '.crash') {
            await sock.sendMessage(chatJid, { text: '💀 *RV Games Bot Offline කරනු ලදී.*\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._' }, { quoted: msg });
            setTimeout(() => { process.exit(0); }, 1000);
        }
        
        // 7️⃣ .menu Command 
        else if (text.trim() === '.menu') {
            const menuText = 
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃   🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 📥 *.si [link 1] [link 2]*\n` +
                `┃ ↳ _ලින්ක් කීපයක් වුවද එකවර Inbox එවයි._\n` +
                `┃\n` +
                `┃ 👥 *.sg [group name] [link 1] [link 2]*\n` +
                `┃ ↳ _අදාළ ගෲප් එක වෙත ෆයිල්ස් සහ Summary වාර්තාව යවයි._\n` +
                `┃\n` +
                `┃ 🎮 *.fg [game name]*\n` +
                `┃ ↳ _FitGirl එකෙන් Game බාගත කර ගැනීමට._\n` +
                `┃\n` +
                `┃ 🛑 *.stop*\n` +
                `┃ ↳ _සිදු වෙමින් පවතින ඕනෑම ක්‍රියාවලියක් නතර කරයි._\n` +
                `┃\n` +
                `┃ ⚡ *.speed*\n` +
                `┃ ↳ _සර්වර් එකේ සැබෑ DL වේගය මනියි._\n` +
                `┃\n` +
                `┃ 🧹 *.dc*\n` +
                `┃ ↳ _සර්වර් එකේ ඇති තාවකාලික ෆයිල් මකා දමයි._\n` +
                `┃\n` +
                `┃ 📜 *.menu*\n` +
                `┃ ↳ _මෙම විධාන මෙනුව ලබා දෙයි._\n` +
                `╚════════════════════╝\n\n` +
                `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                
            await sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
        }

        // 8️⃣ 🆕 .fg Command (Step 1: Search Game)
        else if (text.startsWith('.fg ')) {
            const queryName = text.replace('.fg ', '').trim();
            const formattedQuery = queryName.replace(/\s+/g, '+');
            if (!queryName) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර සෙවිය යුතු Game එකේ නමක් ලබා දෙන්න!' }, { quoted: msg });

            const searchMsg = await sock.sendMessage(chatJid, { text: `🔍 FitGirl වෙබ් අඩවියේ *${queryName}* සොයමින් පවතී...` }, { quoted: msg });

            try {
                const response = await axios.get(`https://fitgirl-repacks.site/?s=${formattedQuery}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                
                // FitGirl සෙවුම් ප්‍රතිඵලවල මාතෘකා සහ ලින්ක් Regex මගින් වෙන් කර ගැනීම
                const postRegex = /<h1 class="entry-title"><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/h1>/g;
                let matches;
                const results = [];

                while ((matches = postRegex.exec(response.data)) !== null) {
                    let title = matches[2].replace(/&#(\d+);/g, (m, dec) => String.fromCharCode(dec)).replace(/&amp;/g, '&');
                    results.push({ url: matches[1], title: title });
                }

                if (results.length === 0) {
                    return await sock.sendMessage(chatJid, { text: '❌ කණගාටුයි, ඒ නමින් කිසිදු Game එකක් සොයාගත නොහැකි විය.', edit: searchMsg.key });
                }

                let replyText = `🎮 *FITGIRL SEARCH RESULTS* 🎮\n\n`;
                results.slice(0, 10).forEach((game, index) => {
                    replyText += `*${index + 1}.* ${game.title}\n\n`;
                });
                replyText += `💡 *මීළඟ පියවර:* ඔබට අවශ්‍ය Game එකේ අංකය (Number) පමණක් මෙම මැසේජ් එකට *Reply* කරන්න.`;

                fgStates.set(chatJid, { type: 'search', results: results.slice(0, 10) });
                await sock.sendMessage(chatJid, { text: replyText, edit: searchMsg.key });

            } catch (err) {
                await sock.sendMessage(chatJid, { text: `❌ සෙවීමේදී දෝෂයක් සිදු විය: ${err.message}`, edit: searchMsg.key });
            }
        }

        // 9️⃣ 🆕 Handling Replies for Step 2 & Step 3
        else {
            const chatState = fgStates.get(chatJid);
            if (!chatState) return;

            const cleanText = text.trim();

            // 🛑 Step 2: User replied with a number to select the game
            if (chatState.type === 'search' && /^\d+$/.test(cleanText)) {
                const index = parseInt(cleanText, 10) - 1;
                if (index >= 0 && index < chatState.results.length) {
                    const selectedGame = chatState.results[index];
                    const fetchMsg = await sock.sendMessage(chatJid, { text: `📂 *${selectedGame.title}* පිටුවේ FuckingFast ලින්ක්ස් පරීක්ෂා කරමින්...` }, { quoted: msg });

                    try {
                        const pageRes = await axios.get(selectedGame.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        
                        // FuckingFast ලින්ක්ස් පමණක් Regex මගින් උකහා ගැනීම
                        const ffRegex = /https:\/\/fuckingfast\.co\/[^\s"'>]+/g;
                        const allLinks = pageRes.data.match(ffRegex) || [];
                        const uniqueLinks = [...new Set(allLinks)]; // Duplicate ලින්ක්ස් අයින් කිරීම

                        if (uniqueLinks.length === 0) {
                            return await sock.sendMessage(chatJid, { text: '❌ මෙම Game එක සඳහා FuckingFast ලින්ක්ස් සොයා ගැනීමට නොහැකි විය.', edit: fetchMsg.key });
                        }

                        let partsText = `📦 *GAME PARTS LIST* 📦\n*Game:* ${selectedGame.title}\n\n`;
                        uniqueLinks.forEach((link) => {
                            let partName = link.split('#')[1] || 'Unknown Part';
                            partsText += `🔹 ${decodeURIComponent(partName)}\n`;
                        });

                        partsText += `\n📥 *බාගත කර ගැනීමට මීළඟ පියවර:*\n`;
                        partsText += `• Inbox එකටම ලබා ගැනීමට මෙම මැසේජ් එකට *si* ලෙස රිප්ලයි කරන්න.\n`;
                        partsText += `• Group එකකට යැවීමට මෙම මැසේජ් එකට *sg [group_name]* ලෙස රිප්ලයි කරන්න. (Ex: \`sg pro games\`)`;

                        fgStates.set(chatJid, { type: 'parts', links: uniqueLinks, title: selectedGame.title });
                        await sock.sendMessage(chatJid, { text: partsText, edit: fetchMsg.key });

                    } catch (err) {
                        await sock.sendMessage(chatJid, { text: `❌ දත්ත ලබා ගැනීමේ දෝෂයකි: ${err.message}`, edit: fetchMsg.key });
                    }
                }
            }

            // 🛑 Step 3: User replied 'si' or 'sg [group]' to download chunks
            else if (chatState.type === 'parts' && (cleanText.toLowerCase() === 'si' || cleanText.toLowerCase().startsWith('sg '))) {
                const links = chatState.links;
                let targetJid = senderJid; // Default: Inbox

                if (cleanText.toLowerCase().startsWith('sg ')) {
                    const targetGroupName = cleanText.substring(3).trim().toLowerCase();
                    if (!targetGroupName) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ගෲප් නාමයක් ලබා දෙන්න.' }, { quoted: msg });

                    const searchGroupNotify = await sock.sendMessage(chatJid, { text: `🔍 '${targetGroupName}' ගෲප් එක සොයමින් පවතී...` }, { quoted: msg });
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        let found = false;
                        for (let jid in groups) {
                            if (groups[jid].subject.toLowerCase().includes(targetGroupName)) {
                                targetJid = jid; found = true; break;
                            }
                        }
                        if (!found) {
                            return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ඔබ සිටින ගෲප් එකක් සොයාගත නොහැකි විය.', edit: searchGroupNotify.key });
                        }
                        await sock.sendMessage(chatJid, { text: `✅ ගෲප් එක තහවුරුයි! බාගත කිරීම් දැන් ආරම්භ වේ...`, edit: searchGroupNotify.key });
                    } catch (e) {
                        return await sock.sendMessage(chatJid, { text: '❌ ගෲප් දත්ත පරීක්ෂා කිරීමේදී දෝෂයක් ඇති විය.', edit: searchGroupNotify.key });
                    }
                }

                fgStates.delete(chatJid); // Process එක පටන් ගත් නිසා State එක මකා දමයි

                const startTime = Date.now();
                let uploadedCount = 0;
                let wasStopped = false;

                for (let ffLink of links) {
                    const baseUrl = ffLink.split('#')[0];
                    let partFileName = ffLink.split('#')[1] || `Part_${Date.now()}`;
                    partFileName = decodeURIComponent(partFileName).replace(/[/\\?%*:|"<>]/g, '-').trim();

                    const bypassMsg = await sock.sendMessage(chatJid, { text: `🔄 FuckingFast ලින්ක් එක Bypass කරමින්:\n*${partFileName}*...` });

                    try {
                        const ffPage = await axios.get(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        
                        // FuckingFast පිටුවේ ඇති window.open එක ඇතුලේ තියෙන සැබෑ Direct DL Link එක ගැනීම
                        const dlMatch = ffPage.data.match(/window\.open\(['"](https:\/\/dl\.fuckingfast\.co\/dl\/[^'"]+)['"]/);
                        if (!dlMatch || !dlMatch[1]) {
                            await sock.sendMessage(chatJid, { text: `⚠️ *${partFileName}* සඳහා Direct Download Link එක සොයා ගැනීමට නොහැකි වූ නිසා මඟහරින ලදී.`, edit: bypassMsg.key });
                            continue;
                        }

                        const directDownloadUrl = dlMatch[1];
                        
                        // තාවකාලික Bypass මැසේජ් එක මකා දමා Core Downloader එකට වැඩේ බාරදීම
                        await sock.sendMessage(chatJid, { delete: bypassMsg.key }).catch(() => {});

                        const result = await handleDownloadAndUpload(directDownloadUrl, sock, msg, targetJid, partFileName);

                        if (result === 'STOPPED') { wasStopped = true; break; }
                        if (result) uploadedCount++;

                    } catch (err) {
                        await sock.sendMessage(chatJid, { text: `❌ *${partFileName}* බාගත කිරීමේදී දෝෂයක් සිදු විය: ${err.message}`, edit: bypassMsg.key }).catch(() => {});
                    }
                }

                const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

                // 📊 සියල්ල අවසානයේ Summary වාර්තාව යැවීම
                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁延 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `**𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetJid, { text: summaryText });
                    if (targetJid !== chatJid) {
                        await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!` });
                    }
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `🛑 *පරිශීලකයා විසින් ක්‍රියාවලිය නැවැත්වූ නිසා Summary වාර්තාව අවලංගු කර ඇත.*` });
                }
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                process.exit(1); 
            } else {
                setTimeout(() => startBot(), 5000); 
            }
        } else if (connection === 'open') {
            console.log('🎉 RV Games Bot Connected Successfully!');
        }
    });
}

startBot();
