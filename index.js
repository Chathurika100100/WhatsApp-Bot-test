import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import crypto from 'node:crypto';

// ==================== 🔐 CRYPTO FIX ====================
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto || crypto;
if (!global.crypto) global.crypto = crypto.webcrypto || crypto;

// ==================== 🌐 WEB SERVER ====================
let connectionStatus = 'initializing';
let lastError = null;
let retryCount = 0;
const MAX_RETRIES = 3;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', connection: connectionStatus, lastError, retries: retryCount }));
    } else if (req.url === '/clear-auth') {
        try {
            if (fs.existsSync(authFolder)) {
                fs.rmSync(authFolder, { recursive: true, force: true });
                fs.mkdirSync(authFolder, { recursive: true });
            }
            res.end(JSON.stringify({ status: 'auth cleared' }));
        } catch (e) { res.end(JSON.stringify({ error: e.message })); }
    } else {
        res.end('*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑* | 𝙾𝚗𝚕𝚒𝚗𝚎 ✅');
    }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));

const authFolder = './bot_session';
const tempFolder = './temp';
const activeTasks = new Map();
const fitgirlSessions = new Map();

if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });
if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

// ==================== 📂 SESSION ID SETUP ====================
function setupSession() {
    const credsPath = path.join(authFolder, 'creds.json');
    const sessionId = process.env.SESSION_ID;
    if (!sessionId) { console.error("❌ SESSION_ID not found!"); process.exit(1); }

    try {
        let base64String = sessionId.trim();
        if (base64String.includes(';;;')) base64String = base64String.split(';;;').pop();
        else if (base64String.includes('~')) base64String = base64String.split('~').pop();
        else if (base64String.includes(':')) base64String = base64String.split(':').pop();

        const decrypted = Buffer.from(base64String, 'base64').toString('utf-8');
        JSON.parse(decrypted);
        fs.writeFileSync(credsPath, decrypted);
        console.log("✅ SESSION_ID loaded");
    } catch (err) {
        console.error("❌ SESSION_ID invalid:", err.message);
        process.exit(1);
    }
}
setupSession();

function getProgressBar(percent) {
    const filled = Math.round((percent / 100) * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function getExtensionFromMime(mimeType) {
    const map = {
        'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
        'application/x-rar-compressed': '.rar', 'application/vnd.rar': '.rar',
        'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png',
        'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'text/plain': '.txt',
        'application/octet-stream': '.bin'
    };
    return map[mimeType] || '.bin';
}

// ==================== 🎮 FITGIRL SCRAPER ====================
async function searchFitGirl(query) {
    try {
        const { data: html } = await axios.get(`https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const results = [];
        const regex = /<article[^>]*>[\s\S]*?<h[12][^>]*class=["']entry-title["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[12]>[\s\S]*?<\/article>/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            const url = match[1].trim();
            const title = match[2].replace(/<[^>]+>/g, '').trim();
            if (url && title && !results.find(r => r.url === url)) {
                results.push({ url, title });
                if (results.length >= 5) break;
            }
        }
        return results;
    } catch (err) { return []; }
}

async function getFitGirlDownloadLinks(gameUrl) {
    try {
        const { data: html } = await axios.get(gameUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const lowerHtml = html.toLowerCase();
        const ffIndex = lowerHtml.indexOf('fuckingfast');
        if (ffIndex === -1) return { links: [], filenames: [] };

        const chunk = html.substring(ffIndex, ffIndex + 100000);
        const links = [];
        const filenames = [];
        const regex = /https:\/\/fuckingfast\.co\/[a-zA-Z0-9_-]+#([^"'\s<>\]\\]+)/g;
        let match;
        while ((match = regex.exec(chunk)) !== null) {
            if (!links.includes(match[0])) {
                links.push(match[0]);
                filenames.push(decodeURIComponent(match[1]));
            }
        }
        return { links, filenames };
    } catch (err) { return { links: [], filenames: [] }; }
}

async function getFuckingFastDirectLink(shortUrl) {
    try {
        const baseUrl = shortUrl.split('#')[0];
        const { data: html } = await axios.get(baseUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000, maxRedirects: 5
        });
        const patterns = [
            /window\.open\(["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']\)/,
            /location\.href\s*=\s*["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']/,
            /["'](https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+)["']/,
            /(https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+)/
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) return match[1];
        }
        return null;
    } catch (err) { return null; }
}

// ==================== 📥 DOWNLOADER CORE (STREAMING - LOW MEMORY) ====================
async function handleDownloadAndUpload(url, sock, msg, sendToJid, forcedFileName = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _ලින්ක් එක පරීක්ෂා කරමින්..._\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });

    const controller = new AbortController();
    activeTasks.set(chatJid, { controller, progressMsgKey: progressMsg.key, tempFilePath: null });
    let tempFilePath = '';

    try {
        const response = await axios({
            url, method: 'GET', responseType: 'stream', signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        let fileName = forcedFileName || '';
        const contentDisposition = response.headers['content-disposition'];
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName && contentDisposition) {
            const match = contentDisposition.match(/filename\*=\s*UTF-8''([^;\r\n]*)/i) || 
                          contentDisposition.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
            if (match && match[1]) fileName = decodeURIComponent(match[1]);
        }
        if (!fileName) {
            try {
                const cleanName = url.split('/').pop().split('?')[0].split('#')[0];
                if (cleanName.includes('.')) fileName = decodeURIComponent(cleanName);
            } catch (e) {}
        }
        if (fileName) fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim();
        if (!fileName || fileName.length > 200) fileName = `RV_Games_${Date.now()}`;
        if (!fileName.includes('.')) fileName += getExtensionFromMime(contentType);

        const totalLength = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedLength = 0;
        let lastUpdateTime = Date.now();

        tempFilePath = path.join(tempFolder, `${Date.now()}_${fileName}`);
        const writer = fs.createWriteStream(tempFilePath);
        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).tempFilePath = tempFilePath;

        // Stream with backpressure - no memory buffering
        response.data.on('data', async (chunk) => {
            if (controller.signal.aborted) return;
            downloadedLength += chunk.length;
            const now = Date.now();
            if (now - lastUpdateTime > 8000) {
                lastUpdateTime = now;
                const dlMB = (downloadedLength / (1024 * 1024)).toFixed(1);
                const percent = totalLength ? ((downloadedLength / totalLength) * 100).toFixed(1) : '?';
                const totMB = totalLength ? (totalLength / (1024 * 1024)).toFixed(1) : '?';
                const bar = getProgressBar(totalLength ? parseFloat(percent) : 50);
                const text = `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n📥 *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ...*\n\n🎮 \`${fileName}\`\n${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB\n\n⏳ _කරුණාකර රැඳී සිටින්න..._`;
                await sock.sendMessage(chatJid, { text, edit: progressMsg.key }).catch(() => {});
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            controller.signal.addEventListener('abort', () => { writer.destroy(); reject(new Error('STOPPED')); });
        });

        // Upload with progress simulation (no actual progress tracking to save memory)
        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n📤 *ᴜᴘʟᴏᴀᴅɪɴɢ...*\n\n🎮 \`${fileName}\`\n⏳ _කරුණාකර රැඳී සිටින්න, spam නොකරන්න..._`, edit: progressMsg.key }).catch(() => {});

        await sock.sendMessage(sendToJid, {
            document: { url: tempFilePath },
            mimetype: contentType,
            fileName,
            caption: `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`
        });

        // IMMEDIATE CLEANUP
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ *\`${fileName}\`*\n\n_සාර්ථකව උඩුගත කරන ලදී!_ 🚀\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: progressMsg.key }).catch(() => {});
        return true;

    } catch (error) {
        const task = activeTasks.get(chatJid);
        if (task && task.tempFilePath && fs.existsSync(task.tempFilePath)) {
            try { fs.unlinkSync(task.tempFilePath); } catch (e) {}
        }
        activeTasks.delete(chatJid);
        if (axios.isCancel(error) || error.message === 'STOPPED' || controller.signal.aborted) return 'STOPPED';
        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *ᴇʀʀᴏʀ!*\n\n⚠️ ${error.message}\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

// ==================== 🎮 FITGIRL BULK DOWNLOADER ====================
async function handleFitGirlDownload(links, filenames, sock, msg, sendToJid, mode) {
    const chatJid = msg.key.remoteJid;
    const startTime = Date.now();
    let uploadedCount = 0;
    let wasStopped = false;

    const initialNotify = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🎮 _FitGirl Parts ${links.length} ක් process කරමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡, 𝑑𝑜𝑛'𝑡 𝑠𝑝𝑎𝑚...` });

    for (let i = 0; i < links.length; i++) {
        if (wasStopped) break;
        const shortUrl = links[i];
        const fileName = filenames[i];

        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n⏳ [${i+1}/${links.length}] \`${fileName}\`\n\n_ප්‍රොසෙස් වෙමින්..._`, edit: initialNotify.key }).catch(() => {});

        const directUrl = await getFuckingFastDirectLink(shortUrl);
        if (!directUrl) {
            await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n⚠️ [${i+1}/${links.length}] \`${fileName}\`\n\n_Skip කරන ලදී_ ❌`, edit: initialNotify.key }).catch(() => {});
            continue;
        }

        const res = await handleDownloadAndUpload(directUrl, sock, msg, sendToJid, fileName);
        if (res === 'STOPPED') { wasStopped = true; break; }
        if (res) uploadedCount++;

        // FORCE GARBAGE COLLECTION between parts
        if (global.gc) global.gc();
    }

    const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const summaryText = `╔════════════════════╗\n┃ *👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑*\n╚════════════════════╝\n\n✅ *𝑆𝑡𝑎𝑡𝑢𝑠:* _සම්පූර්ණයි_\n📦 *𝑃𝑎𝑟𝑡𝑠:* ${uploadedCount}/${links.length}\n⏱️ *𝑇𝑖𝑚𝑒:* ${totalTimeSeconds}s\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;

    if (mode === 'group') {
        await sock.sendMessage(sendToJid, { text: summaryText });
        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ ${uploadedCount} 𝑝𝑎𝑟𝑡𝑠 _ගෲප් එකට සාර්ථකව යවන ලදී!_ 🚀`, edit: initialNotify.key });
    } else {
        await sock.sendMessage(chatJid, { text: summaryText, edit: initialNotify.key });
    }
}

// ==================== 🤖 BOT START ====================
async function startBot() {
    console.log('🚀 Starting RV Games Bot...');
    connectionStatus = 'connecting';

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        console.log('📂 Auth loaded');

        let version;
        try {
            const versionData = await fetchLatestBaileysVersion();
            version = versionData.version;
            console.log(`📦 Baileys v${version.join('.')}`);
        } catch (e) { version = [2, 3000, 1015901307]; }

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }), // SILENT - zero memory for logs
            browser: ['RV Games Bot', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast') || jid?.endsWith('@newsletter'),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: false,
            maxMsgRetryCount: 1,
            retryRequestDelayMs: 10000,
            // CRITICAL: Disable all caching to save memory
            msgRetryCounterMap: new Map(),
            // Use minimal features
            getMessage: async () => undefined
        });

        sock.ev.on('creds.update', saveCreds);

        // ==================== MESSAGE HANDLER ====================
        sock.ev.on('messages.upsert', async m => {
            try {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "";
                const trimmedText = text.trim();
                const chatJid = msg.key.remoteJid;
                const senderJid = msg.key.participant || msg.key.remoteJid || "";

                // 🔒 SECURITY CHECK
                const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039'];
                const senderNumber = senderJid.split('@')[0].split(':')[0];
                if (!allowedNumbers.includes(senderNumber)) {
                    return await sock.sendMessage(chatJid, { 
                        text: `🔒 *𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸𝚅𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n❌ *Sorry, Access Denied!*\nඔබට මෙම බොට්ගේ විධාන (Commands) භාවිතා කිරීමට අවසර නැත.\n\n_This bot is restricted to authorized users only._\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*` 
                    }, { quoted: msg });
                }

                // 🎮 FitGirl Number Selection
                if (fitgirlSessions.has(chatJid)) {
                    const session = fitgirlSessions.get(chatJid);
                    if (session.step === 'search') {
                        const num = parseInt(trimmedText.replace(/^\./, ''));
                        if (!isNaN(num) && num >= 1 && num <= session.results.length) {
                            const selected = session.results[num - 1];
                            session.step = 'fetching';
                            const fetchMsg = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 \`${selected.title}\`\n\n_Links ලබා ගනිමින්..._\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
                            const { links, filenames } = await getFitGirlDownloadLinks(selected.url);
                            if (links.length === 0) {
                                fitgirlSessions.delete(chatJid);
                                return await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _Links හමු නොවීය._\n\n_වෙනත් game එකක් උත්සාහ කරන්න..._ ⏳\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`, edit: fetchMsg.key });
                            }
                            session.links = links; session.filenames = filenames; session.step = 'links';
                            let linksText = `╔════════════════════╗\n┃ *📦 ${selected.title}*\n╚════════════════════╝\n\n*බාගත කළ හැකි Parts:*\n\n`;
                            filenames.forEach((f, i) => linksText += `${i + 1}. \`${f}\`\n`);
                            linksText += `\n*📥 Download කිරීමට:*\n• Inbox → reply: \`.si\`\n• Group → reply: \`.sg [group name]\`\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                            await sock.sendMessage(chatJid, { text: linksText, edit: fetchMsg.key });
                            return;
                        }
                    }
                }

                if (!text.startsWith('.')) return;
                const urlRegex = /(https?:\/\/[^\s]+)/g;

                // 🎮 .fg Command
                if (text.startsWith('.fg ')) {
                    const query = text.replace('.fg ', '').trim();
                    if (!query) return await sock.sendMessage(chatJid, { 
                        text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n🎮 *.fg [game name]*\n\n_උදාහරණ:_\n• *.fg Far Cry 3*\n• *.fg GTA 5*\n• *.fg Elden Ring*\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` 
                    }, { quoted: msg });

                    const notifyMsg = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _FitGirl වලින් සොයමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
                    const results = await searchFitGirl(query);
                    if (results.length === 0) return await sock.sendMessage(chatJid, { 
                        text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _Results හමු නොවීය._\n\n_වෙනත් නමකින් උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notifyMsg.key 
                    });

                    fitgirlSessions.set(chatJid, { step: 'search', results, selectedUrl: null, links: [], filenames: [], createdAt: Date.now() });
                    let listText = `╔════════════════════╗\n┃ *🎮 FitGirl Search Results*\n╚════════════════════╝\n\n`;
                    results.forEach((r, i) => listText += `*${i + 1}.* ${r.title}\n`);
                    listText += `\n*Game එක select කිරීමට number එක reply කරන්න.*\n_(උදා: 1, 2, 3)_\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                    await sock.sendMessage(chatJid, { text: listText, edit: notifyMsg.key });
                }

                // 1️⃣ .si Command
                else if (text.startsWith('.si')) {
                    const urls = text.match(urlRegex) || [];
                    if (urls.length === 0 && fitgirlSessions.has(chatJid)) {
                        const session = fitgirlSessions.get(chatJid);
                        if (session.step === 'links') {
                            await handleFitGirlDownload(session.links, session.filenames, sock, msg, senderJid, 'inbox');
                            fitgirlSessions.delete(chatJid); return;
                        }
                    }
                    if (urls.length === 0) return await sock.sendMessage(chatJid, { 
                        text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n📥 *.si [link]*\n\n_උදාහරණ:_\n• *.si https://example.com/file.zip*\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` 
                    }, { quoted: msg });

                    for (let url of urls) {
                        const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                        if (res === 'STOPPED') break;
                    }
                }

                // 2️⃣ .sg Command
                else if (text.startsWith('.sg ')) {
                    let groupName = text.replace('.sg ', '');
                    const urls = text.match(urlRegex) || [];
                    urls.forEach(u => groupName = groupName.replace(u, ''));
                    groupName = groupName.trim().toLowerCase();

                    if (urls.length === 0 && fitgirlSessions.has(chatJid)) {
                        const session = fitgirlSessions.get(chatJid);
                        if (session.step === 'links') {
                            if (!groupName) return await sock.sendMessage(chatJid, { 
                                text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n👥 *.sg [group name]*\n\n_උදාහරණ:_\n• *.sg pro games*\n• *.sg rv*\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` 
                            }, { quoted: msg });
                            const notify = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _'${groupName}' ගෲප් එක සොයමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` });
                            try {
                                const groups = await sock.groupFetchAllParticipating();
                                let targetGroupJid = null;
                                for (let jid in groups) { if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; } }
                                if (!targetGroupJid) { fitgirlSessions.delete(chatJid); return await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _ගෲප් එක හමු නොවීය._\n\n_වෙනත් නමකින් උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key }); }
                                await handleFitGirlDownload(session.links, session.filenames, sock, msg, targetGroupJid, 'group');
                                fitgirlSessions.delete(chatJid); return;
                            } catch (e) { fitgirlSessions.delete(chatJid); return await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _දෝෂයක් ඇති විය._\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key }); }
                        }
                    }
                    if (urls.length === 0) return await sock.sendMessage(chatJid, { 
                        text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n👥 *.sg [group] [link]*\n\n_උදාහරණ:_\n• *.sg pro https://example.com/file.zip*\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` 
                    }, { quoted: msg });
                    if (!groupName) return await sock.sendMessage(chatJid, { 
                        text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *Usage Error!*\n\n👥 *.sg [group name] [link]*\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` 
                    }, { quoted: msg });

                    const notify = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🔍 _'${groupName}' ගෲප් එක සොයමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` });
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        let targetGroupJid = null;
                        for (let jid in groups) { if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; } }
                        if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _ගෲප් එක හමු නොවීය._\n\n_වෙනත් නමකින් උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key });

                        let uploadedCount = 0, wasStopped = false;
                        for (let url of urls) {
                            const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                            if (success === 'STOPPED') { wasStopped = true; break; }
                            if (success) uploadedCount++;
                        }
                        const summary = `╔════════════════════╗\n┃ *👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚄𝙻𝚃𝚁𝙰 𝙱𝙾𝚃👑*\n╚════════════════════╝\n\n✅ _සම්පූර්ණයි_\n📦 𝑃𝑎𝑟𝑡𝑠: ${uploadedCount}\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;
                        if (uploadedCount > 0 && !wasStopped) {
                            await sock.sendMessage(targetGroupJid, { text: summary });
                            await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ ${uploadedCount} 𝑝𝑎𝑟𝑡𝑠 _යවන ලදී!_ 🚀`, edit: notify.key });
                        }
                    } catch (e) { await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _දෝෂයක් ඇති විය._\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key }); }
                }

                // 3️⃣ .stop
                else if (text.trim().startsWith('.stop')) {
                    if (activeTasks.has(chatJid)) {
                        const task = activeTasks.get(chatJid);
                        task.controller.abort();
                        if (task.tempFilePath && fs.existsSync(task.tempFilePath)) { try { fs.unlinkSync(task.tempFilePath); } catch (e) {} }
                        activeTasks.delete(chatJid);
                        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n✅ *𝑆𝑡𝑜𝑝𝑝𝑒𝑑!* 🛑\n\n_ක්‍රියාවලිය නවත්වන ලදී._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ *𝑁𝑜 𝑎𝑐𝑡𝑖𝑣𝑒 𝑡𝑎𝑠𝑘.*\n\n_ක්‍රියාවලියක් ආරම්භ කර නැත._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
                    }
                }

                // 4️⃣ .speed
                else if (text.trim() === '.speed') {
                    const notify = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n⚡ _සර්වර් වේගය පරීක්ෂා කරමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
                    try {
                        const pingStart = Date.now();
                        await axios.get('https://google.com', { timeout: 10000 });
                        const ping = Date.now() - pingStart;
                        const dlStart = Date.now();
                        await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer', timeout: 30000 });
                        const dlSpeed = (8 / ((Date.now() - dlStart) / 1000)).toFixed(2);
                        const ulStart = Date.now();
                        await axios.post('https://httpbin.org/post', 'A'.repeat(1048576), { headers: { 'Content-Type': 'text/plain' }, timeout: 30000 });
                        const ulSpeed = (8 / ((Date.now() - ulStart) / 1000)).toFixed(2);
                        await sock.sendMessage(chatJid, { 
                            text: `╔════════════════════╗\n┃ *⚡ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝚂𝙴𝚁𝚅𝙴𝚁 𝚂𝙿𝙴𝙴𝙳*\n╚════════════════════╝\n\n🏓 *𝑃𝑖𝑛𝑔:* \`${ping}ms\`\n📥 *𝐷𝑜𝑤𝑛𝑙𝑜𝑎𝑑:* \`${dlSpeed} Mbps\`\n📤 *𝑈𝑝𝑙𝑜𝑎𝑑:* \`${ulSpeed} Mbps\`\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, 
                            edit: notify.key 
                        });
                    } catch (e) { await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _දෝෂයක් ඇති විය._\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key }); }
                }

                // 5️⃣ .dc
                else if (text.trim() === '.dc') {
                    const notify = await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n🧹 _සිස් කරමින්..._\n\n⏳ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡...` }, { quoted: msg });
                    try {
                        const files = fs.readdirSync(tempFolder);
                        let count = 0, space = 0;
                        files.forEach(f => {
                            const fp = path.join(tempFolder, f);
                            const stat = fs.statSync(fp);
                            if (stat.isFile()) { space += stat.size; fs.unlinkSync(fp); count++; }
                        });
                        await sock.sendMessage(chatJid, { 
                            text: `╔════════════════════╗\n┃ *🧹 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙳𝙸𝚂𝙺 𝙲𝙻𝙴𝙰𝙽𝙴𝚁*\n╚════════════════════╝\n\n✅ *𝑆𝑡𝑎𝑡𝑢𝑠:* _සිස් කරන ලදී_\n🗑️ *𝑅𝑒𝑚𝑜𝑣𝑒𝑑:* \`${count} files\`\n📦 *𝐹𝑟𝑒𝑒𝑑:* \`${(space/1024/1024).toFixed(2)}MB\`\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, 
                            edit: notify.key 
                        });
                    } catch (e) { await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n❌ _දෝෂයක් ඇති විය._\n\n_නැවත උත්සාහ කරන්න..._ ⏳\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`, edit: notify.key }); }
                }

                // 6️⃣ .crash
                else if (text.trim() === '.crash') {
                    await sock.sendMessage(chatJid, { text: `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂👑*\n\n💀 *Bot Offline කරනු ලදී.*\n\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._\n\n_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_` }, { quoted: msg });
                    setTimeout(() => process.exit(0), 1000);
                }

                // 7️⃣ .menu
                else if (text.trim() === '.menu') {
                    const menu = `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                        `╔════════════════════╗\n` +
                        `┃    🤖 *MAIN COMMANDS MENU* \n` +
                        `╚════════════════════╝\n` +
                        `┃ 🎮 *.fg [game name]*\n` +
                        `┃ ↳ _FitGirl වලින් game එක search කරලා parts ලබා දෙයි._\n` +
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
                    await sock.sendMessage(chatJid, { text: menu }, { quoted: msg });
                }
            } catch (err) {
                console.error('Handler error:', err.message);
            }
        });

        // 🧹 Auto cleanup
        setInterval(() => {
            const now = Date.now();
            for (const [jid, session] of fitgirlSessions.entries()) {
                if (now - (session.createdAt || 0) > 10 * 60 * 1000) fitgirlSessions.delete(jid);
            }
            // Clean old temp files
            try {
                const files = fs.readdirSync(tempFolder);
                files.forEach(f => {
                    const fp = path.join(tempFolder, f);
                    const stat = fs.statSync(fp);
                    if (stat.isFile() && (now - stat.mtimeMs > 30 * 60 * 1000)) {
                        fs.unlinkSync(fp);
                    }
                });
            } catch (e) {}
        }, 5 * 60 * 1000);

        // ==================== CONNECTION HANDLER ====================
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) console.log('📱 QR received');
            if (connection === 'connecting') { connectionStatus = 'connecting'; console.log('⏳ Connecting...'); }
            if (connection === 'open') { connectionStatus = 'connected'; retryCount = 0; lastError = null; console.log('✅ Connected!'); }
            if (connection === 'close') {
                connectionStatus = 'disconnected';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || 'Unknown';
                lastError = `${statusCode}: ${errorMessage}`;
                console.error(`❌ Closed: ${statusCode}`);
                if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                    process.exit(1);
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    process.exit(1);
                } else {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                        process.exit(1);
                    }
                    setTimeout(() => startBot(), 5000);
                }
            }
        });

        sock.ev.on('error', (err) => {
            console.error('Socket error:', err.message);
        });

    } catch (err) {
        console.error('Fatal:', err.message);
        setTimeout(() => startBot(), 10000);
    }
}

startBot();
