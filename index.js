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
    res.end('*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑* | 𝙾𝚗𝚕𝚒𝚗𝚎 ✅');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server is running on port ${PORT}`);
});

const authFolder = './bot_session';
const activeTasks = new Map(); 
const msgRetryCounterCache = new NodeCache(); // මැසේජ් Decrypt වීමේ ගැටලු මඟහරවා ගැනීමට

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

// 📊 Progress Bar 
function getProgressBar(percent) {
    const total = 10;
    const filled = Math.round((percent / 100) * total);
    const empty = total - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

// 🗂️ Extension Generator based on MIME-Type
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

// 📥 Heavy Lift Downloader & Auto Content Displayer
async function handleDownloadAndUpload(url, sock, msg, sendToJid) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _ලින්ක් එක පරීක්ෂා කරමින්..._\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });

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
            if (utf8Match && utf8Match[1]) {
                fileName = decodeURIComponent(utf8Match[1]);
            } else {
                const normalMatch = contentDisposition.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
                if (normalMatch && normalMatch[1]) {
                    fileName = normalMatch[1];
                }
            }
        }

        if (!fileName) {
            try {
                const urlParts = url.split('/');
                const lastPart = urlParts[urlParts.length - 1];
                const cleanName = lastPart.split('?')[0].split('#')[0];
                if (cleanName && cleanName.includes('.')) {
                    fileName = decodeURIComponent(cleanName);
                }
            } catch (e) {
                console.log("URL එකෙන් නම ගන්න බැරි වුණා.");
            }
        }

        if (fileName) {
            fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim(); 
        }

        if (!fileName || fileName.length > 200) {
            fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        }

        if (!fileName.includes('.')) {
            const ext = getExtensionFromMime(contentType);
            fileName += ext;
        }

        const totalLength = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedLength = 0;
        let lastUpdateTime = Date.now();

        tempFilePath = path.join('./', `${Date.now()}_${fileName}`);
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
            if (now - lastUpdateTime > 2000) { 
                lastUpdateTime = now;

                if (controller.signal.aborted) return; 

                const dlMB = (downloadedLength / (1024 * 1024)).toFixed(1);

                if (totalLength) {
                    const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                    const totMB = (totalLength / (1024 * 1024)).toFixed(1);
                    const bar = getProgressBar(percent);
                    const text = `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n📥 *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ...*\n\n🎮 \`${fileName}\`\n${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB\n\n⏳ _කරුණාකර රැඳී සිටින්න..._`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n📥 *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ...*\n\n🎮 \`${fileName}\`\n📦 Downloaded: ${dlMB}MB (Size Unknown)\n\n⏳ _කරුණාකර රැඳී සිටින්න..._`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                }
            }
        });

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
            if (controller.signal.aborted) {
                clearInterval(uploadInterval);
                return;
            }
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const bar = getProgressBar(uploadPercent);
                const text = `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n📤 *ᴜᴘʟᴏᴀᴅɪɴɢ...*\n\n🎮 \`${fileName}\`\n${bar} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB\n\n⏳ _කරුණාකර රැඳී සිටින්න..._`;
                await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
            }
        }, 1500);

        if (activeTasks.has(chatJid)) {
            activeTasks.get(chatJid).uploadInterval = uploadInterval;
        }

        await sock.sendMessage(sendToJid, { 
            document: { url: tempFilePath }, 
            mimetype: contentType, 
            fileName: fileName,
            caption: `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`
        });

        clearInterval(uploadInterval);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ *\`${fileName}\`*\n\n_සාර්ථකව උඩුගත කරන ලදී!_ 🚀\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: progressMsg.key }).catch(() => {});
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

        console.error(error);
        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *ᴇʀʀᴏʀ!*\n\n⚠️ ෆයිල් එක ලබා ගැනීමට නොහැකි විය.\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: progressMsg.key }).catch(() => {});
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
                     msg.message?.videoMessage?.caption || 
                     "";

        if (!text.startsWith('.')) return; 

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;

        // 🔒 PRIVATE BOT SECURITY CHECK
        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 

        console.log(`[SECURITY CHECK] Command received from: ${senderNumber}`);

        if (!allowedNumbers.includes(senderNumber)) {
            const privateMessage = 
                `🔒 *𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸𝚅𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                `❌ *Sorry, Access Denied!*\n` +
                `ඔබට මෙම බොට්ගේ විධාන (Commands) භාවිතා කිරීමට අවසර නැත.\n\n` +
                `_This bot is restricted to authorized users only._\n\n` +
                `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;

            return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // 1️⃣ .si Command 
        if (text.startsWith('.si ')) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n📥 *.si [link]*\n\n_කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // 2️⃣ .sg Command
        else if (text.startsWith('.sg ')) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n👥 *.sg [group name] [link]*\n\n_කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });

            let groupName = text.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) return await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n👥 *.sg [group name] [link]*\n\n_කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
            const initialNotify = await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _'${groupName}' ගෲප් එක සොයමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _ගෲප් එක හමු නොවීය._\n\n_වෙනත් නමකින් උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` });

                const startTime = Date.now();
                let uploadedCount = 0;
                let wasStopped = false;

                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `┃ *👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑*\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ *𝑆𝑡𝑎𝑡𝑢𝑠:* _සම්පූර්ණයි_\n` +
                        `│ 📦 *𝑇𝑜𝑡𝑎𝑙 𝑃𝑎𝑟𝑡𝑠:* ${uploadedCount}\n` +
                        `│ ⏱️ *𝑇𝑖𝑚𝑒 𝑇𝑎𝑘𝑒𝑛:* ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ ${uploadedCount} 𝑝𝑎𝑟𝑡𝑠 _ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!_ 🚀`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🛑 *𝑆𝑡𝑜𝑝𝑝𝑒𝑑!*\n\n_ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය._\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` });
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
                                        `┃ *👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑*\n` +
                                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                                        `🛑 *𝑆𝑡𝑎𝑡𝑢𝑠: 𝑃𝑟𝑜𝑐𝑒𝑠𝑠 𝑆𝑡𝑜𝑝𝑝𝑒𝑑!*\n` +
                                        `⚠️ _දත්ත බාගත කිරීම හෝ යැවීම පරිශීලකයා විසින් නවතා දමා ඇත._\n\n` +
                                        `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                    await sock.sendMessage(chatJid, { text: stoppedText, edit: task.progressMsgKey }).catch(() => {});
                }

                setTimeout(() => {
                    if (task.tempFilePath && fs.existsSync(task.tempFilePath)) {
                        try { fs.unlinkSync(task.tempFilePath); } catch (e) {}
                    }
                }, 1000);

                activeTasks.delete(chatJid);
                await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ *𝑆𝑡𝑜𝑝𝑝𝑒𝑑!* 🛑\n\n_සියලුම සක්‍රීය ඩවුන්ලෝඩ්/අප්ලෝඩ් ක්‍රියාවලීන් නතර කර දත්ත ඉවත් කරන ලදී._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *𝑁𝑜 𝑎𝑐𝑡𝑖𝑣𝑒 𝑡𝑎𝑠𝑘.*\n\n_මේ මොහොතේ කිසිදු ෆයිල් එකක් බාගත වෙමින් පවතින්නේ නැත._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
            }
        }

        // 4️⃣ .speed Command
        else if (text.trim() === '.speed') {
            const notify = await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n⚡ _සර්වර් වේගය පරීක්ෂා කරමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
            try {
                // 🏓 Ping Check
                const pingStart = Date.now();
                await axios.get('https://google.com');
                const pingTime = Date.now() - pingStart;

                // 📥 Download Speed (1MB බාගත කර පරීක්ෂා කිරීම)
                const dlStart = Date.now();
                await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer' }); 
                const dlEnd = Date.now();
                const dlDuration = (dlEnd - dlStart) / 1000;
                const downloadSpeed = (8 / dlDuration).toFixed(2); // Mbps වලින්

                // 📤 Upload Speed (1MB දත්ත ප්‍රමාණයක් යවා පරීක්ෂා කිරීම)
                const payload = 'A'.repeat(1048576); // 1MB ප්‍රමාණයේ Dummy Text එකක්
                const ulStart = Date.now();
                await axios.post('https://httpbin.org/post', payload, {
                    headers: { 'Content-Type': 'text/plain' }
                });
                const ulEnd = Date.now();
                const ulDuration = (ulEnd - ulStart) / 1000;
                const uploadSpeed = (8 / ulDuration).toFixed(2); // Mbps වලින්

                // 📊 ප්‍රතිඵලය
                const speedText = `╔════════════════════╗\n` +
                                  `┃ *⚡ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚂𝙴𝚁𝚅𝙴𝚁 𝚂𝙿𝙴𝙴𝙳*\n` +
                                  `╚════════════════════╝\n\n` +
                                  `🏓 *𝑃𝑖𝑛𝑔:* \`${pingTime} ms\`\n` +
                                  `📥 *𝐷𝑜𝑤𝑛𝑙𝑜𝑎𝑑:* \`${downloadSpeed} Mbps\`\n` +
                                  `📤 *𝑈𝑝𝑙𝑜𝑎𝑑:* \`${uploadSpeed} Mbps\`\n\n` +
                                  `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;

                await sock.sendMessage(msg.key.remoteJid, { text: speedText, edit: notify.key });
            } catch (error) {
                console.error("Speed test Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _Speed test failed._\n\n⚠️ ${error.message}\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key });
            }
        }

        // 5️⃣ .dc Command (Disk Cleaner)
        else if (text.trim() === '.dc') {
            const notify = await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🧹 _සර්වර් එකේ තාවකාලික ෆයිල් ඉවත් කරමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
            try {
                const directory = './'; // Main directory එක
                const files = fs.readdirSync(directory);
                let deletedCount = 0;
                let freedSpace = 0;

                files.forEach(file => {
                    const filePath = path.join(directory, file);
                    const stat = fs.statSync(filePath);

                    // ⚠️ බොට්ව දුවන්න ඕනෙම කරන වැදගත් ෆයිල් සහ ෆෝල්ඩර් ඩිලීට් වීම වැළැක්වීමට (White-list)
                    const protectedFiles = ['index.js', 'package.json', 'package-lock.json', 'node_modules', 'bot_session', '.env', '.gitignore', '.git'];

                    if (!protectedFiles.includes(file) && stat.isFile()) {
                        freedSpace += stat.size; // අයින් කරන සයිස් එක එකතු කරගන්නවා
                        fs.unlinkSync(filePath); // ෆයිල් එක ඩිලීට් කරනවා
                        deletedCount++;
                    }
                });

                const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);

                const clearText = `╔════════════════════╗\n` +
                                  `┃ *🧹 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙳𝙸𝚂𝙺 𝙲𝙻𝙴𝙰𝙽𝙴𝚁*\n` +
                                  `╚════════════════════╝\n\n` +
                                  `✅ *𝑆𝑡𝑎𝑡𝑢𝑠:* _සිස් කරන ලදී_\n` +
                                  `🗑️ *𝑅𝑒𝑚𝑜𝑣𝑒𝑑:* \`${deletedCount} files\`\n` +
                                  `📦 *𝐹𝑟𝑒𝑒𝑑:* \`${freedMB} MB\`\n\n` +
                                  `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;

                await sock.sendMessage(msg.key.remoteJid, { text: clearText, edit: notify.key });
            } catch (error) {
                console.error("Disk Cleaner Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _Disk එක Clear කිරීමේදී දෝෂයක් ඇති විය._\n\n⚠️ ${error.message}\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key });
            }
        }
        // 6️⃣ .crash Command (Bot Offline කර නවතා දැමීම)
        else if (text.trim() === '.crash') {
            await sock.sendMessage(msg.key.remoteJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n💀 *Bot Offline කරනු ලදී.*\n\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
            console.log("💀 Manual Crash triggered: Bot stopped.");

            // සර්වර් එක සම්පූර්ණයෙන්ම නතර කරයි (Restart නොවනු ඇත)
            setTimeout(() => {
                process.exit(0); 
            }, 1000);
        }
        // 7️⃣ .menu Command 
        else if (text.trim() === '.menu') {
            const menuText = 
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃    🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 📥 *.si [link 1] [link 2]*\n` +
                `┃ ↳ _ලින්ක් කීපයක් වුවද එකවර Inbox එවයි._\n` +
                `┃\n` +
                `┃ 👥 *.sg [group name] [link 1] [link 2]*\n` +
                `┃ ↳ _අදාළ ගෲප් එක වෙත ෆයිල්ස් සහ Summary වාර්තාව යවයි._\n` +
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

            await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
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
