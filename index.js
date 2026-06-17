import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';

// ═══════════════════════════════════════════════════════════════
// 🌐 Web Server for Railway
// ═══════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
    res.end('RV Games Ultra Bot is Online!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server is running on port ${PORT}`);
});

const authFolder = './bot_session';
const activeTasks = new Map();
const msgRetryCounterCache = new NodeCache();

// ═══════════════════════════════════════════════════════════════
// 📦 FitGirl Session Cache (RAM optimized - stores minimal data)
// ═══════════════════════════════════════════════════════════════
const fitgirlSessions = new Map(); // chatJid -> { searchResults: [], fileNames: [], fuckingFastLinks: [], gameTitle: '' }
const FITGIRL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ═══════════════════════════════════════════════════════════════
// 📂 Session ID Setup
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 📊 Progress Bar
// ═══════════════════════════════════════════════════════════════
function getProgressBar(percent) {
    const total = 10;
    const filled = Math.round((percent / 100) * total);
    const empty = total - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

// ═══════════════════════════════════════════════════════════════
// 🗂️ Extension Generator
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 🧹 RAM Cleanup Helper
// ═══════════════════════════════════════════════════════════════
function cleanupFitgirlSession(chatJid) {
    if (fitgirlSessions.has(chatJid)) {
        fitgirlSessions.delete(chatJid);
        console.log(`🧹 FitGirl session cleaned for ${chatJid}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// 🔍 FITGIRL REPACKS SCRAPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// 1️⃣ Search FitGirl for games
async function searchFitGirl(gameName) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(gameName)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const results = [];

        $('article').each((i, el) => {
            const titleEl = $(el).find('h1.entry-title a, h2.entry-title a').first();
            const title = titleEl.text().trim();
            const link = titleEl.attr('href');
            const excerpt = $(el).find('.entry-content p').first().text().trim().substring(0, 200);
            const date = $(el).find('.entry-date').text().trim();

            if (title && link) {
                results.push({
                    index: i + 1,
                    title,
                    link,
                    excerpt,
                    date
                });
            }
        });

        return results;
    } catch (error) {
        console.error('FitGirl Search Error:', error.message);
        return [];
    }
}

// 2️⃣ Extract FuckingFast links from a FitGirl game page
async function extractFuckingFastLinks(gameUrl) {
    try {
        const response = await axios.get(gameUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const links = [];

        // Find all FuckingFast links
        $('a[href*="fuckingfast.co"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                // Extract filename after #
                const fileName = href.split('#').pop() || `part${i + 1}`;
                links.push({
                    index: i + 1,
                    originalUrl: href,
                    fileName: fileName.replace(/_/g, ' ')
                });
            }
        });

        return links;
    } catch (error) {
        console.error('Extract Links Error:', error.message);
        return [];
    }
}

// 3️⃣ Get Direct Download Link from FuckingFast page
async function getDirectDownloadLink(fuckingFastUrl) {
    try {
        const response = await axios.get(fuckingFastUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });

        const html = response.data;

        // Method 1: Look for window.open with direct dl link
        const windowOpenMatch = html.match(/window\.open\s*\(\s*["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']/);
        if (windowOpenMatch) {
            return windowOpenMatch[1];
        }

        // Method 2: Look for atob decoded link in download function
        const atobMatch = html.match(/window\.open\s*\(\s*atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/);
        if (atobMatch) {
            const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
            if (decoded.startsWith('https://dl.fuckingfast.co')) {
                return decoded;
            }
        }

        // Method 3: Look for any dl.fuckingfast.co link in the page
        const dlMatch = html.match(/https:\/\/dl\.fuckingfast\.co\/dl\/[^"'\s]+/);
        if (dlMatch) {
            return dlMatch[0];
        }

        // Method 4: Look for base64 encoded URL in script tags
        const scriptMatch = html.match(/["']([A-Za-z0-9+/=]{50,})["']/);
        if (scriptMatch) {
            try {
                const decoded = Buffer.from(scriptMatch[1], 'base64').toString('utf-8');
                if (decoded.startsWith('https://dl.fuckingfast.co')) {
                    return decoded;
                }
            } catch (e) {}
        }

        return null;
    } catch (error) {
        console.error('Direct Link Error:', error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// 📥 Heavy Lift Downloader & Auto Content Displayer
// ═══════════════════════════════════════════════════════════════
async function handleDownloadAndUpload(url, sock, msg, sendToJid, fileNameOverride = null) {
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

        let fileName = fileNameOverride || '';
        const contentDisposition = response.headers['content-disposition'];
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName) {
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
                    const text = `📥 *Downloading:* ${fileName}\n📊 ${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `📥 *Downloading:* ${fileName}\n📦 Downloaded: ${dlMB}MB (Size Unknown)`;
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
                const text = `📤 *Uploading:* ${fileName}\n📊 ${bar} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB`;
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

        console.error(error);
        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ෆයිල් එක ලබා ගැනීමට නොහැකි විය.`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// 🤖 MAIN BOT FUNCTION
// ═══════════════════════════════════════════════════════════════
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
                `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

            return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // ═══════════════════════════════════════════════════════
        // 🎮 .fg COMMAND - FitGirl Repacks Integration
        // ═══════════════════════════════════════════════════════
        if (text.startsWith('.fg ')) {
            const gameName = text.replace('.fg ', '').trim();
            if (!gameName) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර Game එකේ නම දෙන්න.\nඋදා: `.fg Far Cry 3`' }, { quoted: msg });
            }

            const searchMsg = await sock.sendMessage(chatJid, { text: `🔍 FitGirl වෙතින් "${gameName}" සොයමින්...` }, { quoted: msg });

            try {
                const results = await searchFitGirl(gameName);

                if (results.length === 0) {
                    return await sock.sendMessage(chatJid, { text: `❌ "${gameName}" සඳහා ප්‍රතිඵල කිසිවක් හමු නොවීය.`, edit: searchMsg.key });
                }

                // Store results in session (RAM optimized)
                fitgirlSessions.set(chatJid, {
                    searchResults: results,
                    timestamp: Date.now()
                });

                let resultText = `*🎮 FitGirl Search Results: "${gameName}"*\n\n`;
                results.forEach((r, i) => {
                    resultText += `*${r.index}.* ${r.title}\n`;
                    resultText += `   📅 ${r.date || 'N/A'}\n`;
                    resultText += `   📝 ${r.excerpt ? r.excerpt.substring(0, 80) + '...' : 'N/A'}\n\n`;
                });
                resultText += `*Reply with the number to select a game.*\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;

                await sock.sendMessage(chatJid, { text: resultText, edit: searchMsg.key });

            } catch (error) {
                console.error('.fg Error:', error);
                await sock.sendMessage(chatJid, { text: `❌ FitGirl Search දෝෂයකි: ${error.message}`, edit: searchMsg.key });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 📋 Reply to FitGirl Search Results (Number Selection)
        // ═══════════════════════════════════════════════════════
        else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation?.includes('FitGirl Search Results')) {
            const selectedNum = parseInt(text.trim());
            const session = fitgirlSessions.get(chatJid);

            if (!session || !session.searchResults) {
                return await sock.sendMessage(chatJid, { text: '❌ Session කල් ඉකුත් වී ඇත. නැවත `.fg` command එක භාවිතා කරන්න.' }, { quoted: msg });
            }

            const selectedGame = session.searchResults.find(r => r.index === selectedNum);
            if (!selectedGame) {
                return await sock.sendMessage(chatJid, { text: `❌ වලංගු අංකයක් නොවේ. 1 සිට ${session.searchResults.length} දක්වා තෝරන්න.` }, { quoted: msg });
            }

            const extractMsg = await sock.sendMessage(chatJid, { text: `📥 "${selectedGame.title}" එකේ links extract කරමින්...` }, { quoted: msg });

            try {
                const links = await extractFuckingFastLinks(selectedGame.link);

                if (links.length === 0) {
                    cleanupFitgirlSession(chatJid);
                    return await sock.sendMessage(chatJid, { text: `❌ "${selectedGame.title}" එකේ FuckingFast links හමු නොවීය.`, edit: extractMsg.key });
                }

                // Update session with links
                session.fileNames = links.map(l => l.fileName);
                session.fuckingFastLinks = links;
                session.gameTitle = selectedGame.title;
                session.timestamp = Date.now();

                let linksText = `*🎮 ${selectedGame.title}*\n`;
                linksText += `*📦 Total Parts: ${links.length}*\n\n`;

                links.forEach((l, i) => {
                    linksText += `${i + 1}. ${l.fileName}\n`;
                });

                linksText += `\n*Commands:*\n`;
                linksText += `• *si all* - සියලුම parts inbox එකට\n`;
                linksText += `• *sg [group name] all* - සියලුම parts group එකට\n`;
                linksText += `• *si [number]* - ඒ number එකේ part එක සහ ඊට පහළ සියලු parts\n`;
                linksText += `• *sg [group name] [number]* - ඒ number එකේ part එක සහ ඊට පහළ සියලු parts group එකට\n\n`;
                linksText += `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;

                await sock.sendMessage(chatJid, { text: linksText, edit: extractMsg.key });

            } catch (error) {
                console.error('Extract Error:', error);
                cleanupFitgirlSession(chatJid);
                await sock.sendMessage(chatJid, { text: `❌ Links extract කිරීමේ දෝෂයකි: ${error.message}`, edit: extractMsg.key });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 📋 Reply to FitGirl File List (Download Commands)
        // ═══════════════════════════════════════════════════════
        else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation?.includes('Total Parts:')) {
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.fuckingFastLinks) {
                return await sock.sendMessage(chatJid, { text: '❌ Session කල් ඉකුත් වී ඇත. නැවත `.fg` command එක භාවිතා කරන්න.' }, { quoted: msg });
            }

            const replyText = text.trim().toLowerCase();

            // si all - Send all parts to inbox
            if (replyText === 'si all') {
                const startMsg = await sock.sendMessage(chatJid, { text: `📥 සියලුම ${session.fuckingFastLinks.length} parts inbox එකට යවමින්...` }, { quoted: msg });
                let uploadedCount = 0;
                let wasStopped = false;
                const startTime = Date.now();

                for (let i = 0; i < session.fuckingFastLinks.length; i++) {
                    const link = session.fuckingFastLinks[i];
                    const progressText = `⏳ Processing: ${link.fileName}\n📊 ${i + 1}/${session.fuckingFastLinks.length} parts`;
                    await sock.sendMessage(chatJid, { text: progressText, edit: startMsg.key }).catch(() => {});

                    const directUrl = await getDirectDownloadLink(link.originalUrl);
                    if (!directUrl) {
                        await sock.sendMessage(chatJid, { text: `⚠️ ${link.fileName} එකේ direct link එක ලබා ගැනීමට නොහැකි විය. Skip කරන ලදී.` }).catch(() => {});
                        continue;
                    }

                    const res = await handleDownloadAndUpload(directUrl, sock, msg, senderJid, link.fileName);
                    if (res === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (res) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

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

                    await sock.sendMessage(chatJid, { text: summaryText });
                }

                cleanupFitgirlSession(chatJid);
            }

            // sg [group name] all - Send all parts to group
            else if (replyText.startsWith('sg ') && replyText.endsWith(' all')) {
                const groupName = replyText.replace('sg ', '').replace(' all', '').trim();
                if (!groupName) {
                    return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර group name එක සඳහන් කරන්න.' }, { quoted: msg });
                }

                const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let targetGroupJid = null;

                    for (let jid in groups) {
                        if (groups[jid].subject.toLowerCase().includes(groupName)) {
                            targetGroupJid = jid; break;
                        }
                    }

                    if (!targetGroupJid) {
                        return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                    }

                    const startTime = Date.now();
                    let uploadedCount = 0;
                    let wasStopped = false;

                    for (let i = 0; i < session.fuckingFastLinks.length; i++) {
                        const link = session.fuckingFastLinks[i];
                        const progressText = `⏳ Group Upload: ${link.fileName}\n📊 ${i + 1}/${session.fuckingFastLinks.length} parts`;
                        await sock.sendMessage(chatJid, { text: progressText, edit: initialNotify.key }).catch(() => {});

                        const directUrl = await getDirectDownloadLink(link.originalUrl);
                        if (!directUrl) continue;

                        const res = await handleDownloadAndUpload(directUrl, sock, msg, targetGroupJid, link.fileName);
                        if (res === 'STOPPED') {
                            wasStopped = true;
                            break;
                        }
                        if (res) uploadedCount++;
                    }

                    const endTime = Date.now();
                    const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

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

                cleanupFitgirlSession(chatJid);
            }

            // si [number] - Send from that number onwards to inbox
            else if (replyText.startsWith('si ') && !replyText.includes(' all') && !replyText.includes('sg ')) {
                const partNum = parseInt(replyText.replace('si ', '').trim());
                if (isNaN(partNum) || partNum < 1 || partNum > session.fuckingFastLinks.length) {
                    return await sock.sendMessage(chatJid, { text: `❌ වලංගු අංකයක් නොවේ. 1 සිට ${session.fuckingFastLinks.length} දක්වා තෝරන්න.` }, { quoted: msg });
                }

                const startMsg = await sock.sendMessage(chatJid, { text: `📥 Part ${partNum} සහ ඊට පහළ parts inbox එකට යවමින්...` }, { quoted: msg });
                const linksToSend = session.fuckingFastLinks.slice(partNum - 1);
                let uploadedCount = 0;
                let wasStopped = false;
                const startTime = Date.now();

                for (let i = 0; i < linksToSend.length; i++) {
                    const link = linksToSend[i];
                    const actualIndex = partNum - 1 + i;
                    const progressText = `⏳ Processing: ${link.fileName}\n📊 ${actualIndex + 1}/${session.fuckingFastLinks.length} parts`;
                    await sock.sendMessage(chatJid, { text: progressText, edit: startMsg.key }).catch(() => {});

                    const directUrl = await getDirectDownloadLink(link.originalUrl);
                    if (!directUrl) continue;

                    const res = await handleDownloadAndUpload(directUrl, sock, msg, senderJid, link.fileName);
                    if (res === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (res) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

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

                    await sock.sendMessage(chatJid, { text: summaryText });
                }

                cleanupFitgirlSession(chatJid);
            }

            // sg [group name] [number] - Send from that number onwards to group
            else if (replyText.startsWith('sg ') && !replyText.endsWith(' all')) {
                const parts = replyText.replace('sg ', '').trim().split(' ');
                const groupName = parts.slice(0, -1).join(' ');
                const partNum = parseInt(parts[parts.length - 1]);

                if (!groupName || isNaN(partNum) || partNum < 1 || partNum > session.fuckingFastLinks.length) {
                    return await sock.sendMessage(chatJid, { text: `❌ වැරදි format එකක්. උදා: sg pro games 5\nවලංගු අංකය: 1 සිට ${session.fuckingFastLinks.length} දක්වා`, edit: startMsg.key });
                }

                const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let targetGroupJid = null;

                    for (let jid in groups) {
                        if (groups[jid].subject.toLowerCase().includes(groupName)) {
                            targetGroupJid = jid; break;
                        }
                    }

                    if (!targetGroupJid) {
                        return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                    }

                    const linksToSend = session.fuckingFastLinks.slice(partNum - 1);
                    const startTime = Date.now();
                    let uploadedCount = 0;
                    let wasStopped = false;

                    for (let i = 0; i < linksToSend.length; i++) {
                        const link = linksToSend[i];
                        const actualIndex = partNum - 1 + i;
                        const progressText = `⏳ Group Upload: ${link.fileName}\n📊 ${actualIndex + 1}/${session.fuckingFastLinks.length} parts`;
                        await sock.sendMessage(chatJid, { text: progressText, edit: initialNotify.key }).catch(() => {});

                        const directUrl = await getDirectDownloadLink(link.originalUrl);
                        if (!directUrl) continue;

                        const res = await handleDownloadAndUpload(directUrl, sock, msg, targetGroupJid, link.fileName);
                        if (res === 'STOPPED') {
                            wasStopped = true;
                            break;
                        }
                        if (res) uploadedCount++;
                    }

                    const endTime = Date.now();
                    const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

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

                cleanupFitgirlSession(chatJid);
            }
        }

        // ═══════════════════════════════════════════════════════
        // 1️⃣ .si Command (Original)
        // ═══════════════════════════════════════════════════════
        else if (text.startsWith('.si ')) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break;
            }
        }

        // ═══════════════════════════════════════════════════════
        // 2️⃣ .sg Command (Original)
        // ═══════════════════════════════════════════════════════
        else if (text.startsWith('.sg ')) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });

            let groupName = text.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න.' }, { quoted: msg });
            const initialNotify = await sock.sendMessage(msg.key.remoteJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });

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
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(msg.key.remoteJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(msg.key.remoteJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.' });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 3️⃣ .stop Command
        // ═══════════════════════════════════════════════════════
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

        // ═══════════════════════════════════════════════════════
        // 4️⃣ .speed Command
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.speed') {
            await sock.sendMessage(msg.key.remoteJid, { text: '⚡ RV Games සර්වර් වේගය පරීක්ෂා කරමින් පවතී...' }, { quoted: msg });
            try {
                const pingStart = Date.now();
                await axios.get('https://google.com');
                const pingTime = Date.now() - pingStart;

                const dlStart = Date.now();
                await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer' });
                const dlEnd = Date.now();
                const dlDuration = (dlEnd - dlStart) / 1000;
                const downloadSpeed = (8 / dlDuration).toFixed(2);

                const payload = 'A'.repeat(1048576);
                const ulStart = Date.now();
                await axios.post('https://httpbin.org/post', payload, {
                    headers: { 'Content-Type': 'text/plain' }
                });
                const ulEnd = Date.now();
                const ulDuration = (ulEnd - ulStart) / 1000;
                const uploadSpeed = (8 / ulDuration).toFixed(2);

                const speedText = `*⚡ RV GAMES SERVER SPEED* 🎮\n\n` +
                                  `🏓 *Ping:* \`${pingTime} ms\`\n` +
                                  `📥 *Download Speed:* \`${downloadSpeed} Mbps\`\n` +
                                  `📤 *Upload Speed:* \`${uploadSpeed} Mbps\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(msg.key.remoteJid, { text: speedText }, { quoted: msg });
            } catch (error) {
                console.error("Speed test Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Speed test දෝෂයකි: ${error.message}` }, { quoted: msg });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 5️⃣ .dc Command (Disk Cleaner)
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.dc') {
            await sock.sendMessage(msg.key.remoteJid, { text: '🧹 RV Games සර්වර් එකේ තාවකාලික ෆයිල් ඉවත් කරමින් පවතී...' }, { quoted: msg });
            try {
                const directory = './';
                const files = fs.readdirSync(directory);
                let deletedCount = 0;
                let freedSpace = 0;

                files.forEach(file => {
                    const filePath = path.join(directory, file);
                    const stat = fs.statSync(filePath);
                    const protectedFiles = ['index.js', 'package.json', 'package-lock.json', 'node_modules', 'bot_session', '.env', '.gitignore', '.git'];

                    if (!protectedFiles.includes(file) && stat.isFile()) {
                        freedSpace += stat.size;
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                });

                const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);

                const clearText = `*🧹 RV GAMES DISK CLEANER* ⚙️\n\n` +
                                  `✅ *Status:* Disk Cleaned Successfully!\n` +
                                  `🗑️ *Removed Files:* \`${deletedCount} files\`\n` +
                                  `📦 *Freed Space:* \`${freedMB} MB\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(msg.key.remoteJid, { text: clearText }, { quoted: msg });
            } catch (error) {
                console.error("Disk Cleaner Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Disk එක Clear කිරීමේදී දෝෂයක් ඇති විය: ${error.message}` }, { quoted: msg });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 6️⃣ .crash Command
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.crash') {
            await sock.sendMessage(msg.key.remoteJid, { text: '💀 *RV Games Bot Offline කරනු ලදී.*\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._' }, { quoted: msg });
            console.log("💀 Manual Crash triggered: Bot stopped.");
            setTimeout(() => {
                process.exit(0);
            }, 1000);
        }

        // ═══════════════════════════════════════════════════════
        // 7️⃣ .menu Command (Updated with .fg)
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.menu') {
            const menuText =
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃    🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 🎮 *.fg [game name]*\n` +
                `┃ ↳ _FitGirl වෙතින් game search කර links ලබා ගනී._\n` +
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

            await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 🧹 Periodic RAM Cleanup for FitGirl Sessions
    // ═══════════════════════════════════════════════════════════════
    setInterval(() => {
        const now = Date.now();
        for (const [chatJid, session] of fitgirlSessions.entries()) {
            if (now - session.timestamp > FITGIRL_CACHE_TTL) {
                fitgirlSessions.delete(chatJid);
                console.log(`🧹 Expired FitGirl session cleaned for ${chatJid}`);
            }
        }
    }, 5 * 60 * 1000); // Every 5 minutes

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
