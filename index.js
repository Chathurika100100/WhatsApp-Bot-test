import 'dotenv/config'; 
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http'; 
import axios from 'axios'; 
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio'; // HTML Scraping සඳහා

// 🌐 Web Server for Railway
const server = http.createServer((req, res) => {
    res.end('RV Games Ultra Bot is Online!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server is running on port ${PORT}`);
});

const authFolder = './bot_session';
const activeTasks = new Map(); 
const userState = new Map(); // FitGirl Search/Parts මතක තබා ගැනීමට
const msgRetryCounterCache = new NodeCache(); 

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
        'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-rar-compressed': '.rar',
        'application/vnd.rar': '.rar', 'application/x-rar': '.rar', 'application/pdf': '.pdf',
        'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
        'application/vnd.android.package-archive': '.apk', 'text/plain': '.txt'
    };
    return map[mimeType] || '.bin';
}

// 📥 Heavy Lift Downloader & Auto Content Displayer (RAM Optimized)
async function handleDownloadAndUpload(url, sock, msg, sendToJid, forcedFileName = null) {
    const chatJid = msg.key.remoteJid;
    let displayName = forcedFileName ? forcedFileName : "ෆයිල් එක";
    const progressMsg = await sock.sendMessage(chatJid, { text: `🔍 *${displayName}* පරීක්ෂා කරමින් පවතී...` }, { quoted: msg });
    
    const controller = new AbortController();
    activeTasks.set(chatJid, {
        controller, progressMsgKey: progressMsg.key, uploadInterval: null, tempFilePath: null, writer: null, stream: null 
    });

    let tempFilePath = '';

    try {
        const response = await axios({
            url, method: 'GET', responseType: 'stream', signal: controller.signal, 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });

        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).stream = response.data;

        let fileName = forcedFileName || '';
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName) {
            const contentDisposition = response.headers['content-disposition'];
            if (contentDisposition) {
                const utf8Match = contentDisposition.match(/filename\*=\s*UTF-8''([^;\r\n]*)/i);
                if (utf8Match && utf8Match[1]) fileName = decodeURIComponent(utf8Match[1]);
                else {
                    const normalMatch = contentDisposition.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
                    if (normalMatch && normalMatch[1]) fileName = normalMatch[1];
                }
            }
        }

        if (!fileName) {
            try {
                const cleanName = url.split('/').pop().split('?')[0].split('#')[0];
                if (cleanName && cleanName.includes('.')) fileName = decodeURIComponent(cleanName);
            } catch (e) {}
        }

        if (fileName) fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim(); 
        if (!fileName || fileName.length > 200) fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        if (!fileName.includes('.')) fileName += getExtensionFromMime(contentType);

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
                let text = '';
                if (totalLength) {
                    const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                    const totMB = (totalLength / (1024 * 1024)).toFixed(1);
                    text = `📥 *Downloading:* ${fileName}\n📊 ${getProgressBar(percent)} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB`;
                } else {
                    text = `📥 *Downloading:* ${fileName}\n📦 Downloaded: ${dlMB}MB (Size Unknown)`;
                }
                await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
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
            if (controller.signal.aborted) return clearInterval(uploadInterval);
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const text = `📤 *Uploading:* ${fileName}\n📊 ${getProgressBar(uploadPercent)} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB`;
                await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
            }
        }, 1500);

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

// 🕸️ FuckingFast Bypass (Extract direct link using window.open)
async function extractFuckingFastDirectLink(ffUrl) {
    try {
        const { data } = await axios.get(ffUrl);
        // HTML එක ඇතුලෙ තියෙන window.open("LINK") එක හොයමු
        const match = data.match(/window\.open\(['"]([^'"]+)['"]/);
        if (match && match[1]) {
            return match[1]; // Direct Download Link එක 
        }
    } catch (err) {
        console.error("FF Bypass Error:", err.message);
    }
    return null;
}

// 🚀 Start Bot
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

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;
        
        // 🔒 PRIVATE BOT SECURITY CHECK
        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 

        if (text.startsWith('.') && !allowedNumbers.includes(senderNumber)) {
            const privateMessage = `🔒 *𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸𝚅𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n❌ *Sorry, Access Denied!*\nඔබට මෙම බොට්ගේ විධාන භාවිතා කිරීමට අවසර නැත.\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
            return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // ==========================================
        // 🎮 .fg COMMAND - STEP 1 (Search FitGirl)
        // ==========================================
        if (text.startsWith('.fg ')) {
            const query = text.replace('.fg ', '').trim();
            if (!query) return await sock.sendMessage(chatJid, { text: '❌ ගේම් එකේ නම ඇතුලත් කරන්න.' });

            await sock.sendMessage(chatJid, { text: `🔍 *FitGirl* හරහා '${query}' සොයමින් පවතී...` });
            
            try {
                const { data } = await axios.get(`https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`);
                const $ = cheerio.load(data);
                const results = [];
                
                $('.entry-title a').each((i, el) => {
                    if (i < 10) results.push({ title: $(el).text(), url: $(el).attr('href') });
                });

                if (results.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කිසිදු ගේම් එකක් සොයාගත නොහැකි විය.' });

                let replyText = `🔍 *FitGirl Search Results:*\n\n`;
                results.forEach((r, i) => { replyText += `*${i + 1}.* ${r.title}\n`; });
                replyText += `\n📥 _ඔබට අවශ්‍ය ගේම් එකේ අංකය මෙම මැසේජ් එකට Reply කරන්න._`;

                userState.set(chatJid, { type: 'fg_search', results });
                await sock.sendMessage(chatJid, { text: replyText }, { quoted: msg });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: '❌ සර්ච් කිරීමේදී දෝෂයක් ඇති විය.' });
            }
            return;
        }

        // ==========================================
        // 🔄 REPLY HANDLER (Step 2, 3 & 4)
        // ==========================================
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
            const state = userState.get(chatJid);

            // STEP 2: අංකය Reply කල විට FuckingFast Links සෙවීම
            if (quotedText.includes('🔍 *FitGirl Search Results:*') && state?.type === 'fg_search') {
                const num = parseInt(text.trim());
                if (isNaN(num) || num < 1 || num > state.results.length) return;

                const selectedGame = state.results[num - 1];
                await sock.sendMessage(chatJid, { text: `🔗 *${selectedGame.title}* හි FuckingFast ලින්ක් සොයමින් පවතී...` });

                try {
                    const { data } = await axios.get(selectedGame.url);
                    const $ = cheerio.load(data);
                    const partsList = [];

                    // FuckingFast links ටික හොයමු
                    $('a[href*="fuckingfast.co"]').each((i, el) => {
                        const href = $(el).attr('href');
                        if (href && href.includes('#')) {
                            const fileName = decodeURIComponent(href.split('#')[1]);
                            partsList.push({ url: href, name: fileName });
                        }
                    });

                    if (partsList.length === 0) return await sock.sendMessage(chatJid, { text: '❌ මෙම ගේම් එක සඳහා FuckingFast ලින්ක්ස් හමු නොවුණි.' });

                    let partsMsg = `📦 *Game Parts List:*\n\n`;
                    partsList.forEach((p, i) => { partsMsg += `${i + 1}. ${p.name}\n`; });
                    partsMsg += `\n⚙️ _උපදෙස්: මෙම මැසේජ් එකට Reply කරන්න_\n- *.si all* (ඔක්කොම Inbox ගන්න)\n- *.sg [group] all* (ඔක්කොම Group එකට යවන්න)\n- *.si 5* (5 වෙනි එකේ ඉදන් පහලට Inbox ගන්න)\n- *.sg [group] 5* (5 ඉදන් Group යවන්න)`;

                    userState.set(chatJid, { type: 'fg_parts', parts: partsList });
                    await sock.sendMessage(chatJid, { text: partsMsg }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(chatJid, { text: '❌ ලින්ක් ලබා ගැනීමේදී දෝෂයක්.' });
                }
                return;
            }

            // STEP 3 & 4: Command එකට අනුව Parts Download කර යැවීම
            if (quotedText.includes('📦 *Game Parts List:*') && state?.type === 'fg_parts') {
                const cmd = text.trim();
                const isGroup = cmd.startsWith('.sg ');
                const isInbox = cmd.startsWith('.si ');

                if (!isGroup && !isInbox) return;

                const args = isGroup ? cmd.replace('.sg ', '').split(' ') : cmd.replace('.si ', '').split(' ');
                let targetIdx = args[args.length - 1]; 
                let startIdx = 0;
                let groupName = '';

                if (isGroup) {
                    if (targetIdx.toLowerCase() === 'all') {
                        startIdx = 0; groupName = args.slice(0, -1).join(' ');
                    } else if (!isNaN(targetIdx)) {
                        startIdx = parseInt(targetIdx) - 1; groupName = args.slice(0, -1).join(' ');
                    }
                } else {
                    if (targetIdx.toLowerCase() === 'all') startIdx = 0;
                    else if (!isNaN(targetIdx)) startIdx = parseInt(targetIdx) - 1;
                }

                if (startIdx < 0 || startIdx >= state.parts.length) return await sock.sendMessage(chatJid, { text: '❌ වැරදි අංකයක්.' });

                // Group එකක් නම් JID එක හොයමු
                let targetJid = senderJid;
                if (isGroup) {
                    const groups = await sock.groupFetchAllParticipating();
                    for (let jid in groups) {
                        if (groups[jid].subject.toLowerCase().includes(groupName.toLowerCase())) {
                            targetJid = jid; break;
                        }
                    }
                    if (targetJid === senderJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });
                }

                const initialNotify = await sock.sendMessage(chatJid, { text: `🚀 Parts බාගත කිරීම ආරම්භ කරන ලදී...` });
                const partsToProcess = state.parts.slice(startIdx);
                let uploadedCount = 0;
                let wasStopped = false;

                for (let part of partsToProcess) {
                    // FuckingFast Bypass එක
                    const directUrl = await extractFuckingFastDirectLink(part.url);
                    if (!directUrl) {
                        await sock.sendMessage(chatJid, { text: `⚠️ ${part.name} සඳහා Direct Link එක ලබාගත නොහැකි විය.` });
                        continue;
                    }

                    // Direct link එක handleDownloadAndUpload එකට යැවීම
                    const success = await handleDownloadAndUpload(directUrl, sock, msg, targetJid, part.name);
                    
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                // Final Summary Message
                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `└────────────────────────\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetJid, { text: summaryText });
                    if (isGroup) await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා අවසන්!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලදී.*`, edit: initialNotify.key });
                }
                return;
            }
        }

        // ==========================================
        // වෙනත් Commands (.si, .sg, .stop, .speed, .dc, .menu)
        // ==========================================
        
        // 1️⃣ .si Command (කලින් තිබුණු සාමාන්‍ය ලින්ක් සඳහා)
        if (text.startsWith('.si ') && !quotedMsg?.conversation?.includes('Game Parts List')) {
            if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // 2️⃣ .sg Command (කලින් තිබුණු සාමාන්‍ය ලින්ක් සඳහා)
        else if (text.startsWith('.sg ') && !quotedMsg?.conversation?.includes('Game Parts List')) {
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
                    if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; }
                }

                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });
                
                let uploadedCount = 0; let wasStopped = false;
                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `└────────────────────────\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts ගෲප් එකට යවන ලදී!`, edit: initialNotify.key });
                }
            } catch (error) {
                await sock.sendMessage(chatJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.' });
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
                    const stoppedText = `🛑 *Status: Process Stopped!*\n⚠️ _ක්‍රියාවලිය පරිශීලකයා විසින් නවතා දමා ඇත._\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                    await sock.sendMessage(chatJid, { text: stoppedText, edit: task.progressMsgKey }).catch(() => {});
                }

                setTimeout(() => {
                    if (task.tempFilePath && fs.existsSync(task.tempFilePath)) {
                        try { fs.unlinkSync(task.tempFilePath); } catch (e) {}
                    }
                }, 1000);

                activeTasks.delete(chatJid);
                await sock.sendMessage(chatJid, { text: '✅ සක්‍රීය ක්‍රියාවලීන් නතර කර දත්ත ඉවත් කරන ලදී!' }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, { text: '❌ මේ මොහොතේ කිසිවක් ක්‍රියාත්මක නොවේ.' }, { quoted: msg });
            }
        }

        // 4️⃣ .speed Command
        else if (text.trim() === '.speed') {
            await sock.sendMessage(chatJid, { text: '⚡ RV Games සර්වර් වේගය පරීක්ෂා කරමින් පවතී...' }, { quoted: msg });
            try {
                const pingStart = Date.now();
                await axios.get('https://google.com');
                const pingTime = Date.now() - pingStart;
                
                const dlStart = Date.now();
                await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer' }); 
                const dlDuration = (Date.now() - dlStart) / 1000;
                const downloadSpeed = (8 / dlDuration).toFixed(2);
                
                const payload = 'A'.repeat(1048576); 
                const ulStart = Date.now();
                await axios.post('https://httpbin.org/post', payload, { headers: { 'Content-Type': 'text/plain' } });
                const ulDuration = (Date.now() - ulStart) / 1000;
                const uploadSpeed = (8 / ulDuration).toFixed(2);
                
                const speedText = `*⚡ RV GAMES SERVER SPEED* 🎮\n\n🏓 *Ping:* \`${pingTime} ms\`\n📥 *DL Speed:* \`${downloadSpeed} Mbps\`\n📤 *UP Speed:* \`${uploadSpeed} Mbps\`\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                await sock.sendMessage(chatJid, { text: speedText }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(chatJid, { text: `❌ Speed test දෝෂයකි.` }, { quoted: msg });
            }
        }

        // 5️⃣ .dc Command (Disk Cleaner)
        else if (text.trim() === '.dc') {
            await sock.sendMessage(chatJid, { text: '🧹 තාවකාලික ෆයිල් ඉවත් කරමින් පවතී...' }, { quoted: msg });
            try {
                const files = fs.readdirSync('./');
                let deletedCount = 0; let freedSpace = 0;
                const protectedFiles = ['index.js', 'package.json', 'package-lock.json', 'node_modules', 'bot_session', '.env'];

                files.forEach(file => {
                    const stat = fs.statSync(file);
                    if (!protectedFiles.includes(file) && stat.isFile()) {
                        freedSpace += stat.size; fs.unlinkSync(file); deletedCount++;
                    }
                });

                const clearText = `*🧹 RV GAMES DISK CLEANER*\n\n✅ *Status:* Disk Cleaned!\n🗑️ *Removed:* \`${deletedCount} files\`\n📦 *Freed:* \`${(freedSpace / 1048576).toFixed(2)} MB\`\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                await sock.sendMessage(chatJid, { text: clearText }, { quoted: msg });
            } catch (error) {}
        }
        
        // 6️⃣ .crash Command
        else if (text.trim() === '.crash') {
            await sock.sendMessage(chatJid, { text: '💀 *RV Games Bot Offline කරනු ලදී.*' }, { quoted: msg });
            setTimeout(() => process.exit(0), 1000);
        }

        // 7️⃣ .menu Command 
        else if (text.trim() === '.menu') {
            const menuText = 
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃    🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 🎮 *.fg [game name]*\n` +
                `┃ ↳ _FitGirl හරහා ගේම් සෙවීම._\n` +
                `┃\n` +
                `┃ 📥 *.si [link / part number]*\n` +
                `┃ ↳ _Inbox එකට ෆයිල්ස් යවයි._\n` +
                `┃\n` +
                `┃ 👥 *.sg [group] [link / part no]*\n` +
                `┃ ↳ _අදාළ Group එකට ෆයිල්ස් යවයි._\n` +
                `┃\n` +
                `┃ 🛑 *.stop* | ⚡ *.speed*\n` +
                `┃ 🧹 *.dc* | 📜 *.menu*\n` +
                `╚════════════════════╝\n\n` +
                `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                
            await sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                process.exit(1); 
            } else setTimeout(() => startBot(), 5000); 
        } else if (connection === 'open') console.log('🎉 RV Games Bot Connected Successfully!');
    });
}
startBot();
