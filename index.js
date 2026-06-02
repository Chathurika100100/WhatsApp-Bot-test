import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import NodeCache from 'node-cache';

// ==================== 🔐 CRYPTO FIX FOR NODE.JS 18+ ====================
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}
if (!global.crypto) {
    global.crypto = webcrypto;
}

// ==================== 🌐 WEB SERVER + HEALTH CHECK ====================
let connectionStatus = 'initializing';
let lastError = null;
let retryCount = 0;
const MAX_RETRIES = 5;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            connection: connectionStatus,
            lastError: lastError,
            retries: retryCount,
            timestamp: new Date().toISOString()
        }));
    } else if (req.url === '/clear-auth') {
        try {
            if (fs.existsSync(authFolder)) {
                fs.rmSync(authFolder, { recursive: true, force: true });
                fs.mkdirSync(authFolder, { recursive: true });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'auth cleared', message: 'Restart the service to generate new session' }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
    } else {
        res.end('RV Games Ultra Bot is Online!');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

const authFolder = './bot_session';
const tempFolder = './temp';
const activeTasks = new Map();
const msgRetryCounterCache = new NodeCache({ stdTTL: 60, checkperiod: 60 });
const fitgirlSessions = new Map();

// ෆෝල්ඩර්ස් සාදා ගැනීම
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });
if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

// ==================== 📂 SESSION ID SETUP ====================
function setupSession() {
    const credsPath = path.join(authFolder, 'creds.json');
    const sessionId = process.env.SESSION_ID;

    if (!sessionId) {
        console.error("❌ ERROR: Railway Variables වල SESSION_ID එක දමා නැත!");
        process.exit(1);
    }

    try {
        let base64String = sessionId.trim();
        if (base64String.includes(';;;')) base64String = base64String.split(';;;').pop();
        else if (base64String.includes('~')) base64String = base64String.split('~').pop();
        else if (base64String.includes(':')) base64String = base64String.split(':').pop();
        const decrypted = Buffer.from(base64String, 'base64').toString('utf-8');
        JSON.parse(decrypted);
        fs.writeFileSync(credsPath, decrypted);
        console.log("✅ SESSION_ID creds.json එකට සාර්ථකව ලිව්වා");
    } catch (err) {
        console.error("❌ SESSION_ID decode error:", err.message);
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
        'text/plain': '.txt',
        'application/octet-stream': '.bin'
    };
    return map[mimeType] || '.bin';
}

// ==================== 🎮 FITGIRL SCRAPER ====================
async function searchFitGirl(query) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`;
        const { data: html } = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 20000
        });

        const results = [];
        const articleRegex = /<article[^>]*>[\s\S]*?<h[12][^>]*class=["']entry-title["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[12]>[\s\S]*?<\/article>/gi;
        let match;
        while ((match = articleRegex.exec(html)) !== null) {
            const url = match[1].trim();
            const title = match[2].replace(/<[^>]+>/g, '').trim();
            if (url && title && !results.find(r => r.url === url)) {
                results.push({ url, title });
            }
            if (results.length >= 10) break;
        }

        if (results.length === 0) {
            const linkRegex = /<a[^>]*href=["'](https:\/\/fitgirl-repacks\.site\/[^"']+)["'][^>]*rel=["']bookmark["'][^>]*>([\s\S]*?)<\/a>/gi;
            while ((match = linkRegex.exec(html)) !== null) {
                const url = match[1].trim();
                const title = match[2].replace(/<[^>]+>/g, '').trim();
                if (url && title && !results.find(r => r.url === url)) {
                    results.push({ url, title });
                }
                if (results.length >= 10) break;
            }
        }
        return results;
    } catch (err) {
        console.error('❌ FitGirl search error:', err.message);
        return [];
    }
}

async function getFitGirlDownloadLinks(gameUrl) {
    try {
        const { data: html } = await axios.get(gameUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 20000
        });
        const lowerHtml = html.toLowerCase();
        const ffIndex = lowerHtml.indexOf('fuckingfast');
        if (ffIndex === -1) return { links: [], filenames: [] };

        const chunk = html.substring(ffIndex, ffIndex + 150000);
        const links = [];
        const filenames = [];

        const linkRegex = /https:\/\/fuckingfast\.co\/[a-zA-Z0-9_-]+#([^"'\s<>\]\\]+)/g;
        let match;
        while ((match = linkRegex.exec(chunk)) !== null) {
            const fullUrl = match[0];
            const fileName = decodeURIComponent(match[1]);
            if (!links.includes(fullUrl)) {
                links.push(fullUrl);
                filenames.push(fileName);
            }
        }
        return { links, filenames };
    } catch (err) {
        console.error('❌ FitGirl parse error:', err.message);
        return { links: [], filenames: [] };
    }
}

async function getFuckingFastDirectLink(shortUrl) {
    try {
        const baseUrl = shortUrl.split('#')[0];
        const { data: html } = await axios.get(baseUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 20000,
            maxRedirects: 5
        });
        const patterns = [
            /window\.open\(["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']\)/,
            /window\.open\(["'](https:\/\/[^"']*fuckingfast[^"']+)["']\)/,
            /location\.href\s*=\s*["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']/,
            /location\.replace\(["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']\)/,
            /["'](https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+)["']/,
            /href\s*=\s*["'](https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/,
            /(https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+)/,
            /(https:\/\/[^"'\s]*fuckingfast\.co\/dl\/[^"'\s]*)/
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) return match[1];
        }
        return null;
    } catch (err) {
        console.error('❌ FuckingFast resolve error:', err.message);
        return null;
    }
}

// ==================== 📥 DOWNLOADER CORE (RAM OPTIMIZED) ====================
async function handleDownloadAndUpload(url, sock, msg, sendToJid, forcedFileName = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `🔍 𝖱𝖵 𝖦𝖺𝗆𝖾𝗌 Bot ලින්ක් එක පරීක්ෂා කරමින් පවතී...` }, { quoted: msg });
    const controller = new AbortController();
    
    // 🚀 RAM FIX: අලුත් ලොකු වැඩක් පටන් ගන්න කලින් පරණ කුණු බලහත්කාරයෙන් මකා දැමීම
    if (global.gc) { global.gc(); console.log('🧹 Force GC Executed before download'); }

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
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (activeTasks.has(chatJid)) {
            activeTasks.get(chatJid).stream = response.data;
        }

        let fileName = forcedFileName || '';
        const contentDisposition = response.headers['content-disposition'];
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName && contentDisposition) {
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
                const cleanName = urlParts[urlParts.length - 1].split('?')[0].split('#')[0];
                if (cleanName && cleanName.includes('.')) fileName = decodeURIComponent(cleanName);
            } catch (e) {}
        }

        if (fileName) fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim();
        if (!fileName || fileName.length > 200) fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        if (!fileName.includes('.')) fileName += getExtensionFromMime(contentType);
        
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

        // 🚀 RAM FIX: Stream data events ඇතුළේ await ඉවත් කිරීමෙන් Event Loop එක block වීම වැළැක්වීම
        response.data.on('data', (chunk) => {
            if (controller.signal.aborted) return;
            downloadedLength += chunk.length;
            const now = Date.now();

            // 🚀 RAM FIX: Progress Update එක තත්පර 8කට වරක් කිරීම (නිතරම Edit කරද්දී RAM පිරෙන නිසා)
            if (now - lastUpdateTime > 8000) {
                lastUpdateTime = now;
                const dlMB = (downloadedLength / (1024 * 1024)).toFixed(1);

                if (totalLength) {
                    const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                    const totMB = (totalLength / (1024 * 1024)).toFixed(1);
                    const bar = getProgressBar(percent);
                    const text = `📥 *Downloading:* ${fileName}\n📊 ${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB`;
                    sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `📥 *Downloading:* ${fileName}\n📦 Downloaded: ${dlMB}MB (Size Unknown)`;
                    sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                }

                // ඩවුන්ලෝඩ් මැදදීත් RAM එක ක්ලියර් කිරීම
                if (global.gc) global.gc();
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

        // 🚀 RAM FIX: Upload එක පටන් ගන්න කලින් ආයෙමත් RAM එක හිස් කිරීම
        if (global.gc) global.gc();

        let uploadPercent = 0;
        const totalMB = totalLength ? (totalLength / (1024 * 1024)).toFixed(1) : (downloadedLength / (1024 * 1024)).toFixed(1);
        
        const uploadInterval = setInterval(() => {
            if (controller.signal.aborted) { clearInterval(uploadInterval); return; }
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const bar = getProgressBar(uploadPercent);
                const text = `📤 *Uploading:* ${fileName}\n📊 ${bar} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB`;
                sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
            }
        }, 4000);
        
        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).uploadInterval = uploadInterval;

        // 🚀 RAM FIX: url: path එක වෙනුවට fs.createReadStream යෙදීමෙන් Baileys එකෙන් File එක කෙලින්ම Disk එකෙන් Stream කරයි! (Never crashes)
        await sock.sendMessage(sendToJid, { 
            document: { stream: fs.createReadStream(tempFilePath) }, 
            mimetype: contentType, 
            fileName: fileName,
            caption: `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`
        });
        
        clearInterval(uploadInterval);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, { text: `🎉 *${fileName}* සාර්ථකව යවන ලදී!\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`, edit: progressMsg.key }).catch(() => {});
        if (global.gc) global.gc();
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
        activeTasks.delete(chatJid);

        if (axios.isCancel(error) || error.message === 'STOPPED' || controller.signal.aborted) {
            return 'STOPPED'; 
        }
        await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ${error.message}`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

async function handleFitGirlDownload(links, filenames, sock, msg, sendToJid, mode) {
    const chatJid = msg.key.remoteJid;
    const startTime = Date.now();
    let uploadedCount = 0;
    let wasStopped = false;
    const initialNotify = await sock.sendMessage(chatJid, { 
        text: `🎮 FitGirl Parts ${links.length} ක් process කරමින් පවතී...\n⏳ Direct links resolve කරමින්...` 
    });

    for (let i = 0; i < links.length; i++) {
        if (wasStopped) break;
        const shortUrl = links[i];
        const fileName = filenames[i];

        await sock.sendMessage(chatJid, { 
            text: `⏳ [${i+1}/${links.length}] *${fileName}*\n🔗 Direct link resolve කරමින්...`, 
            edit: initialNotify.key 
        }).catch(() => {});

        const directUrl = await getFuckingFastDirectLink(shortUrl);
        if (!directUrl) {
            await sock.sendMessage(chatJid, { 
                text: `⚠️ [${i+1}/${links.length}] *${fileName}* — Direct link හමු නොවී skip කරනවා.`, 
                edit: initialNotify.key 
            }).catch(() => {});
            continue;
        }

        const res = await handleDownloadAndUpload(directUrl, sock, msg, sendToJid, fileName);
        if (res === 'STOPPED') { wasStopped = true; break; }
        if (res) uploadedCount++;
    }

    const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const summaryText = 
        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
        `       ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
        `┌────────────────────────\n` +
        `│ ✅ Status: Done\n` +
        `│ 📦 Total Parts: ${uploadedCount}\n` +
        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
        `└────────────────────────\n\n` +
        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

    if (mode === 'group') {
        await sock.sendMessage(sendToJid, { text: summaryText }).catch(() => {});
        await sock.sendMessage(chatJid, { 
            text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, 
            edit: initialNotify.key 
        }).catch(() => {});
    } else {
        await sock.sendMessage(chatJid, { text: summaryText, edit: initialNotify.key }).catch(() => {});
    }
}

// ==================== 🤖 BOT START ====================
async function startBot() {
    console.log('🚀 Starting RV Games Bot...');
    connectionStatus = 'connecting';
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        let version;
        try {
            const versionData = await fetchLatestBaileysVersion();
            version = versionData.version;
        } catch (e) {
            version = [2, 3000, 1015901307];
        }

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            // 🚀 RAM FIX: Log level එක 'silent' කිරීමෙන් අනවශ්‍ය Terminal Logs නිසා RAM පිරීම වැළැක්වීම
            logger: pino({ level: 'silent' }),
            browser: ['RV Games Bot', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: false,
            shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast')
        });

        sock.ev.on('creds.update', saveCreds);

        // ==================== MESSAGE HANDLER ====================
        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return; 

            const text = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         msg.message?.imageMessage?.caption || 
                         msg.message?.videoMessage?.caption || "";

            const trimmedText = text.trim();
            const chatJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || msg.key.remoteJid || "";

            // 🔒 PRIVATE BOT SECURITY CHECK
            const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
            const senderNumber = senderJid.split('@')[0].split(':')[0]; 

            if (!allowedNumbers.includes(senderNumber)) {
                const privateMessage = 
                    `🔒 *🔒 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸𝚅𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                    `❌ *Sorry, Access Denied!*\n` +
                    `ඔබට මෙම බොට්ගේ විධාන (Commands) භාවිතා කිරීමට අවසර නැත.\n\n` +
                    `_This bot is restricted to authorized users only._\n\n` +
                    `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
            }

            const urlRegex = /https?:\/\/[^\s]+/gi;

            // 🎮 FitGirl Number Selection (before dot filter)
            if (fitgirlSessions.has(chatJid)) {
                const session = fitgirlSessions.get(chatJid);
                if (session.step === 'search') {
                    const num = parseInt(trimmedText.replace(/^\./, ''));
                    if (!isNaN(num) && num >= 1 && num <= session.results.length) {
                        const selected = session.results[num - 1];
                        session.selectedUrl = selected.url;
                        session.step = 'links_fetching';
                        
                        const fetchNotify = await sock.sendMessage(chatJid, { text: `⏳ *${selected.title}* සඳහා links ලබා ගනිමින් පවතී...` });
                        const { links, filenames } = await getFitGirlDownloadLinks(selected.url);
                        
                        if (links.length === 0) {
                            fitgirlSessions.delete(chatJid);
                            return await sock.sendMessage(chatJid, { text: '❌ මෙම game එක සඳහා FuckingFast links සොයා ගැනීමට නොහැකි විය.', edit: fetchNotify.key });
                        }
                        
                        session.links = links;
                        session.filenames = filenames;
                        session.step = 'links';
                        
                        let replyLinksText = `*🎮 Selected Game:* ${selected.title}\n📦 Total Parts Found: ${links.length}\n\n` +
                                             `📥 Inbox එකට ලබා ගැනීමට *.si* ලෙස reply කරන්න.\n` +
                                             `👥 Group එකකට යැවීමට *.sg [group name]* ලෙස reply කරන්න.\n\n` +
                                             `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                        return await sock.sendMessage(chatJid, { text: replyLinksText, edit: fetchNotify.key });
                    }
                }
            }

            if (!text.startsWith('.')) return;

            // 🔍 .fg Command
            if (text.startsWith('.fg ')) {
                const query = text.replace('.fg ', '').trim();
                if (!query) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර සෙවිය යුතු game එකේ නම ලබා දෙන්න. (උදා: .fg gta v)' }, { quoted: msg });
                
                const notifyMsg = await sock.sendMessage(chatJid, { text: `🔍 FitGirl Repacks වෙබ් අඩවියෙන් *"${query}"* සොයමින් පවතී...` });
                const results = await searchFitGirl(query);
                
                if (results.length === 0) {
                    return await sock.sendMessage(chatJid, { text: '❌ කිසිදු ප්‍රතිඵලයක් හමු නොවීය. කරුණාකර වෙනත් නමකින් නැවත උත්සාහ කරන්න.', edit: notifyMsg.key });
                }
                
                fitgirlSessions.set(chatJid, { step: 'search', results: results, selectedUrl: null, links: [], filenames: [], createdAt: Date.now() });
                let listText = `*🎮 FitGirl Search Results:*\n\n`;
                results.forEach((r, i) => { listText += `*${i + 1}.* ${r.title}\n`; });
                listText += `\n_කරුණාකර game එක select කිරීමට number එක reply කරන්න._\n(උදා: *1*, *2*, *3*)\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                await sock.sendMessage(chatJid, { text: listText, edit: notifyMsg.key });
            }
            // 1️⃣ .si Command
            else if (text.startsWith('.si')) {
                const urls = text.match(urlRegex) || [];
                if (urls.length === 0 && fitgirlSessions.has(chatJid)) {
                    const session = fitgirlSessions.get(chatJid);
                    if (session.step === 'links') {
                        await handleFitGirlDownload(session.links, session.filenames, sock, msg, senderJid, 'inbox');
                        fitgirlSessions.delete(chatJid);
                        return;
                    }
                }
                if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
                for (let url of urls) {
                    const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                    if (res === 'STOPPED') break;
                }
            }
            // 2️⃣ .sg Command
            else if (text.startsWith('.sg ')) {
                let rest = text.replace('.sg ', '').trim();
                const urls = text.match(urlRegex) || [];
                
                if (urls.length === 0 && fitgirlSessions.has(chatJid)) {
                    const session = fitgirlSessions.get(chatJid);
                    if (session.step === 'links') {
                        let groupName = rest;
                        const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 *"${groupName}"* නමින් ඇති ගෲප් එක සොයමින් පවතී...` });
                        try {
                            const groups = await sock.groupFetchAllParticipating();
                            let targetGroupJid = null;
                            for (let jid in groups) {
                                if (groups[jid].subject.toLowerCase().includes(groupName.toLowerCase())) {
                                    targetGroupJid = jid;
                                    break;
                                }
                            }
                            if (!targetGroupJid) {
                                return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                            }
                            await sock.sendMessage(chatJid, { delete: initialNotify.key }).catch(() => {});
                            await handleFitGirlDownload(session.links, session.filenames, sock, msg, targetGroupJid, 'group');
                            fitgirlSessions.delete(chatJid);
                            return;
                        } catch (e) {
                            return await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ${e.message}`, edit: initialNotify.key });
                        }
                    }
                }
                
                if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ගෲප් නමක් සහ ලින්ක් එකක් ලබා දෙන්න. (උදා: .sg MyGroup https://...)' }, { quoted: msg });
                
                let groupName = rest;
                for (let u of urls) { groupName = groupName.replace(u, ''); }
                groupName = groupName.trim();
                
                if (!groupName) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර ගෲප් එකේ නම නිවැරදිව ලබා දෙන්න.' }, { quoted: msg });
                
                const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 *"${groupName}"* නමින් ඇති ගෲප් එක සොයමින් පවතී...` });
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let targetGroupJid = null;
                    for (let jid in groups) {
                        if (groups[jid].subject.toLowerCase().includes(groupName.toLowerCase())) {
                            targetGroupJid = jid;
                            break;
                        }
                    }
                    if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                    
                    const startTime = Date.now();
                    let uploadedCount = 0;
                    let wasStopped = false;
                    for (let url of urls) {
                        const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                        if (success === 'STOPPED') { wasStopped = true; break; }
                        if (success) uploadedCount++;
                    }
                    const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
                    if (uploadedCount > 0 && !wasStopped) {
                        const summaryText = `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` + 
                                            `       ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` + 
                                            `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` + 
                                            `┌────────────────────────\n` + 
                                            `│ ✅ Status: Done\n` + 
                                            `│ 📦 Total Parts: ${uploadedCount}\n` + 
                                            `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` + 
                                            `└────────────────────────\n\n` + 
                                            `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                        await sock.sendMessage(targetGroupJid, { text: summaryText });
                        await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, edit: initialNotify.key });
                    }
                } catch (e) {
                    await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ${e.message}`, edit: initialNotify.key });
                }
            }
            // 3️⃣ .stop Command
            else if (trimmedText === '.stop') {
                if (activeTasks.has(chatJid)) {
                    const task = activeTasks.get(chatJid);
                    task.controller.abort();
                    if (task.uploadInterval) clearInterval(task.uploadInterval);
                    if (task.writer) { try { task.writer.destroy(); } catch (e) {} }
                    if (task.stream) { try { task.stream.destroy(); } catch (e) {} }
                    activeTasks.delete(chatJid);
                    await sock.sendMessage(chatJid, { text: '🛑 සිදු වෙමින් පැවති ක්‍රියාවලිය සාර්ථකව නවත්වන ලදී!' }, { quoted: msg });
                } else {
                    await sock.sendMessage(chatJid, { text: '⚠️ මෙම චැට් එක තුළ දැනට කිසිදු සක්‍රීය ක්‍රියාවලියක් සිදු නොවේ.' }, { quoted: msg });
                }
            }
            // 4️⃣ .speed Command
            else if (trimmedText === '.speed') {
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
                    await sock.sendMessage(chatJid, { text: `❌ Speed test දෝෂය: ${error.message}`, edit: speedNotify.key });
                }
            }
            // 5️⃣ .dc Command
            else if (trimmedText === '.dc') {
                try {
                    const files = fs.readdirSync(tempFolder);
                    let count = 0;
                    files.forEach(file => {
                        fs.unlinkSync(path.join(tempFolder, file));
                        count++;
                    });
                    if (global.gc) global.gc();
                    await sock.sendMessage(chatJid, { text: `🧹 Temp Folder එක සම්පූර්ණයෙන්ම සුද්ද කරන ලදී! (ෆයිල්ස් ${count} ක් මකා දැමුණි)\n🧠 RAM Garbage Collection එක ක්‍රියාත්මක කරන ලදී.` }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(chatJid, { text: `❌ සුද්ද කිරීමේදී දෝෂයක්: ${e.message}` }, { quoted: msg });
                }
            }
            // 6️⃣ .menu Command
            else if (trimmedText === '.menu') {
                const menuText = 
                    `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                    `╔════════════════════╗\n` +
                    `┃   🤖 *MAIN COMMANDS MENU* \n` +
                    `╚════════════════════╝\n` +
                    `┃ 🎮 *.fg [game name]*\n` +
                    `┃ ↳ _FitGirl Repacks වලින් game එක search කර parts ලබා දෙයි._\n` +
                    `┃\n` +
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
                await sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
            }
        });

        // Expired FitGirl Sessions ක්ලියර් කිරීම (මිනිත්තු 5කට වරක්)
        setInterval(() => {
            const now = Date.now();
            for (let [jid, session] of fitgirlSessions.entries()) {
                if (now - session.createdAt > 10 * 60 * 1000) {
                    fitgirlSessions.delete(jid);
                    console.log(`🧹 Cleared expired FitGirl session for: ${jid}`);
                }
            }
        }, 5 * 60 * 1000);

        // ==================== CONNECTION UPDATE ====================
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                connectionStatus = 'disconnected';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message;
                console.log(`❌ Connection closed. Reason: ${reason} (Status Code: ${statusCode})`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.error('❌ Session logged out. Clearing session folder...');
                    connectionStatus = 'logged_out';
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                    process.exit(1);
                } else if (statusCode === 401) {
                    console.error('❌ Unauthorized (401). Session replaced.');
                    process.exit(1);
                } else if (statusCode === DisconnectReason.timedOut) {
                    console.log('⏱️ Connection timed out. Retrying...');
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                        process.exit(1);
                    }
                    setTimeout(() => startBot(), 10000);
                } else {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                        process.exit(1);
                    }
                    setTimeout(() => startBot(), 5000); 
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                retryCount = 0;
                lastError = null;
                console.log('✅ WhatsApp connection is fully OPEN and ACTIVE!');
            }
        });

    } catch (err) {
        console.error('❌ Fatal error starting bot:', err.message);
        connectionStatus = 'error';
        lastError = err.message;
        setTimeout(() => startBot(), 10000);
    }
}

startBot();
