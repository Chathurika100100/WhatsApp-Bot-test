import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
const tempFolder = './temp';
const activeTasks = new Map();
const msgRetryCounterCache = new NodeCache();
const fitgirlSessions = new Map(); // 🎮 FitGirl multi-step sessions

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
        'text/plain': '.txt',
        'application/octet-stream': '.bin'
    };
    return map[mimeType] || '.bin';
}

// ==================== 🎮 FITGIRL SCRAPER FUNCTIONS ====================

async function searchFitGirl(query) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`;
        const { data: html } = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 20000
        });
        
        const results = [];
        
        // Pattern 1: Standard WordPress article structure
        const articleRegex = /<article[^>]*>[\s\S]*?<h[12][^>]*class=["']entry-title["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<<\/a>[\s\S]*?<\/h[12]>[\s\S]*?<\/article>/gi;
        let match;
        while ((match = articleRegex.exec(html)) !== null) {
            const url = match[1].trim();
            const title = match[2].replace(/<<[^>]+>/g, '').trim();
            if (url && title && !results.find(r => r.url === url)) {
                results.push({ url, title });
            }
            if (results.length >= 10) break;
        }
        
        // Pattern 2: Fallback - any bookmark link
        if (results.length === 0) {
            const linkRegex = /<a[^>]*href=["'](https:\/\/fitgirl-repacks\.site\/[^"']+)["'][^>]*rel=["']bookmark["'][^>]*>([\s\S]*?)<<\/a>/gi;
            while ((match = linkRegex.exec(html)) !== null) {
                const url = match[1].trim();
                const title = match[2].replace(/<<[^>]+>/g, '').trim();
                if (url && title && !results.find(r => r.url === url)) {
                    results.push({ url, title });
                }
                if (results.length >= 10) break;
            }
        }
        
        return results;
    } catch (err) {
        console.error('FitGirl search error:', err.message);
        return [];
    }
}

async function getFitGirlDownloadLinks(gameUrl) {
    try {
        const { data: html } = await axios.get(gameUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 20000
        });
        
        // Find FuckingFast section
        const lowerHtml = html.toLowerCase();
        const ffIndex = lowerHtml.indexOf('fuckingfast');
        if (ffIndex === -1) return { links: [], filenames: [] };
        
        // Extract chunk after FuckingFast mention (look ahead 100KB)
        const chunk = html.substring(ffIndex, ffIndex + 100000);
        
        const links = [];
        const filenames = [];
        
        // Find all fuckingfast.co links with hash fragment
        const linkRegex = /https:\/\/fuckingfast\.co\/[a-zA-Z0-9_-]+#([^"'\s<<>\]\\]+)/g;
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
        console.error('FitGirl parse error:', err.message);
        return { links: [], filenames: [] };
    }
}

async function getFuckingFastDirectLink(shortUrl) {
    try {
        const baseUrl = shortUrl.split('#')[0];
        
        const { data: html } = await axios.get(baseUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 20000,
            maxRedirects: 5
        });
        
        // Multiple patterns to find the real download URL
        const patterns = [
            /window\.open\(["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']\)/,
            /window\.open\(["'](https:\/\/[^"']*fuckingfast[^"']+)["']\)/,
            /location\.href\s*=\s*["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']/,
            /location\.replace\(["'](https:\/\/dl\.fuckingfast\.co\/dl\/[^"']+)["']\)/,
            /["'](https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+)["']/,
            /downloadUrl\s*[:=]\s*["'](https:\/\/[^"']+)["']/,
            /url\s*[:=]\s*["'](https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/
        ];
        
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) return match[1];
        }
        
        // Generic fallback
        const genericMatch = html.match(/https:\/\/dl\.fuckingfast\.co\/dl\/[a-zA-Z0-9_-]+/);
        if (genericMatch) return genericMatch[0];
        
        return null;
    } catch (err) {
        console.error('FuckingFast resolve error:', err.message);
        return null;
    }
}

// ==================== 📥 DOWNLOADER CORE ====================

async function handleDownloadAndUpload(url, sock, msg, sendToJid, forcedFileName = null) {
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
                const lastPart = urlParts[urlParts.length - 1];
                const cleanName = lastPart.split('?')[0].split('#')[0];
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

// ==================== 🎮 FITGIRL BULK DOWNLOADER ====================

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
        
        // Update status
        await sock.sendMessage(chatJid, { 
            text: `⏳ [${i+1}/${links.length}] *${fileName}*\n🔗 Direct link resolve කරමින්...`, 
            edit: initialNotify.key 
        }).catch(() => {});

        // Resolve direct link
        const directUrl = await getFuckingFastDirectLink(shortUrl);
        if (!directUrl) {
            await sock.sendMessage(chatJid, { 
                text: `⚠️ [${i+1}/${links.length}] *${fileName}* — Direct link එක හමු නොවී skip කරනවා.`, 
                edit: initialNotify.key 
            }).catch(() => {});
            continue;
        }

        // Download and upload this part
        const res = await handleDownloadAndUpload(directUrl, sock, msg, sendToJid, fileName);
        if (res === 'STOPPED') { wasStopped = true; break; }
        if (res) uploadedCount++;
    }

    const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

    if (uploadedCount > 0 && !wasStopped) {
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
            await sock.sendMessage(sendToJid, { text: summaryText });
            await sock.sendMessage(chatJid, { 
                text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, 
                edit: initialNotify.key 
            });
        } else {
            await sock.sendMessage(chatJid, { text: summaryText, edit: initialNotify.key });
        }
    } else if (wasStopped) {
        await sock.sendMessage(chatJid, { 
            text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා FitGirl download අවලංගු කරන ලදී.*`, 
            edit: initialNotify.key 
        });
    } else {
        await sock.sendMessage(chatJid, { 
            text: `❌ කිසිදු part එකක් download කළ නොහැකි විය.`, 
            edit: initialNotify.key 
        });
    }
}

// ==================== 🤖 BOT START ====================

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
                     
        if (!text.startsWith('.')) {
            // Check for FitGirl number reply (no dot prefix)
            const chatJid = msg.key.remoteJid;
            if (fitgirlSessions.has(chatJid) && fitgirlSessions.get(chatJid).step === 'search') {
                const session = fitgirlSessions.get(chatJid);
                const num = parseInt(text.trim());
                
                if (!isNaN(num) && num >= 1 && num <= session.results.length) {
                    const selected = session.results[num - 1];
                    session.selectedUrl = selected.url;
                    session.step = 'fetching';
                    
                    const fetchMsg = await sock.sendMessage(chatJid, { text: `🔍 *${selected.title}* page එකෙන් links extract කරමින්...` }, { quoted: msg });
                    
                    const { links, filenames } = await getFitGirlDownloadLinks(selected.url);
                    
                    if (links.length === 0) {
                        fitgirlSessions.delete(chatJid);
                        return await sock.sendMessage(chatJid, { text: '❌ FuckingFast links සොයාගත නොහැකි විය. Site එකේ structure එක වෙනස් වී ඇති විය හැක.', edit: fetchMsg.key });
                    }
                    
                    session.links = links;
                    session.filenames = filenames;
                    session.step = 'links';
                    session.linksMsgKey = fetchMsg.key;
                    
                    let linksText = `*📦 ${selected.title} — Download Parts:*\n\n`;
                    filenames.forEach((f, i) => {
                        linksText += `${i + 1}. \`${f}\`\n`;
                    });
                    linksText += `\n_📥 Download කිරීමට:_\n`;
                    linksText += `• Inbox එකට → reply: *.si*\n`;
                    linksText += `• Group එකකට → reply: *.sg [group name]*\n\n`;
                    linksText += `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                    
                    await sock.sendMessage(chatJid, { text: linksText, edit: fetchMsg.key });
                }
            }
            return;
        }

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;
        
        // 🔒 PRIVATE BOT SECURITY CHECK
        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 

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

        // 🎮 .fg Command — FitGirl Search
        if (text.startsWith('.fg ')) {
            const query = text.replace('.fg ', '').trim();
            if (!query) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර game එකේ නම ලබා දෙන්න.\nඋදා: *.fg Far Cry 3*' }, { quoted: msg });
            
            const notifyMsg = await sock.sendMessage(chatJid, { text: '🔍 FitGirl Repacks වලින් search කරමින් පවතී...' }, { quoted: msg });
            
            const results = await searchFitGirl(query);
            if (results.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ FitGirl වලින් results සොයාගත නොහැකි විය. නම වෙනස් කර නැවත උත්සාහ කරන්න.', edit: notifyMsg.key });
            }
            
            fitgirlSessions.set(chatJid, {
                step: 'search',
                results: results,
                selectedUrl: null,
                links: [],
                filenames: [],
                searchMsgKey: notifyMsg.key,
                createdAt: Date.now()
            });
            
            let listText = `*🎮 FitGirl Search Results:*\n\n`;
            results.forEach((r, i) => {
                listText += `*${i + 1}.* ${r.title}\n`;
            });
            listText += `\n_කරුණාකර game එක select කිරීමට number එක reply කරන්න._\n(උදා: *1*, *2*, *3*)\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;
            
            await sock.sendMessage(chatJid, { text: listText, edit: notifyMsg.key });
        }

        // 1️⃣ .si Command (Modified for FitGirl support)
        else if (text.startsWith('.si')) {
            const urls = text.match(urlRegex) || [];
            
            // FitGirl session check
            if (urls.length === 0 && fitgirlSessions.has(chatJid) && fitgirlSessions.get(chatJid).step === 'links') {
                const session = fitgirlSessions.get(chatJid);
                await handleFitGirlDownload(session.links, session.filenames, sock, msg, senderJid, 'inbox');
                fitgirlSessions.delete(chatJid);
                return;
            }
            
            if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // 2️⃣ .sg Command (Modified for FitGirl support)
        else if (text.startsWith('.sg ')) {
            let groupName = text.replace('.sg ', '');
            const urls = text.match(urlRegex) || [];
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            // FitGirl session check
            if (urls.length === 0 && fitgirlSessions.has(chatJid) && fitgirlSessions.get(chatJid).step === 'links') {
                const session = fitgirlSessions.get(chatJid);
                if (!groupName) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න.\nඋදා: *.sg pro games*' }, { quoted: msg });
                
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
                        fitgirlSessions.delete(chatJid);
                        return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.', edit: initialNotify.key });
                    }
                    
                    await handleFitGirlDownload(session.links, session.filenames, sock, msg, targetGroupJid, 'group');
                    fitgirlSessions.delete(chatJid);
                    return;
                    
                } catch (error) {
                    fitgirlSessions.delete(chatJid);
                    return await sock.sendMessage(chatJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.', edit: initialNotify.key });
                }
            }

            if (urls.length === 0) return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
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
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
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
                                        `       ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
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

        // 5️⃣ .dc Command (Disk Cleaner - Safe Version)
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

    // 🧹 Auto cleanup old FitGirl sessions every 5 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [jid, session] of fitgirlSessions.entries()) {
            if (now - (session.createdAt || 0) > 10 * 60 * 1000) {
                fitgirlSessions.delete(jid);
            }
        }
    }, 5 * 60 * 1000);

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
