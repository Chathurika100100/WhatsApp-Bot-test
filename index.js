import 'dotenv/config';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http';
import axios from 'axios';
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';

// ═══════════════════════════════════════════════════════════
// 🌐 WEB SERVER FOR RAILWAY
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// 💾 MESSAGE STORE FOR RETRY HANDLING
// ═══════════════════════════════════════════════════════════
const messageStore = new Map();
const groupMetadataCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

function storeMessage(msg) {
    if (msg.key && msg.key.id && msg.key.remoteJid) {
        const storeKey = `${msg.key.remoteJid}:${msg.key.id}`;
        messageStore.set(storeKey, msg);
        setTimeout(() => messageStore.delete(storeKey), 7200000);
    }
}

async function getMessageFromStore(key) {
    if (!key || !key.remoteJid || !key.id) return undefined;
    const storeKey = `${key.remoteJid}:${key.id}`;
    const msg = messageStore.get(storeKey);
    console.log(`🔍 getMessage lookup: ${storeKey} → ${msg ? 'FOUND' : 'NOT FOUND'}`);
    return msg?.message || undefined;
}

// ═══════════════════════════════════════════════════════════
// 📂 SESSION ID SETUP
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// 📊 UTILITIES
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// 🔒 AUTHORIZED NUMBERS LIST
// ═══════════════════════════════════════════════════════════
const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039'];

function isAuthorized(senderJid) {
    const senderNumber = senderJid.split('@')[0].split(':')[0];
    return allowedNumbers.includes(senderNumber);
}

// ═══════════════════════════════════════════════════════════
// 🔥 FITGIRL REPACKS SCRAPER
// ═══════════════════════════════════════════════════════════
const axiosInstance = axios.create({
    timeout: 30000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
    }
});

async function searchFitGirl(gameName) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(gameName)}`;
        const response = await axiosInstance.get(searchUrl);
        const $ = cheerio.load(response.data);

        const results = [];
        $('article.post').each((i, el) => {
            const title = $(el).find('h1.entry-title a, h2.entry-title a').text().trim();
            const link = $(el).find('h1.entry-title a, h2.entry-title a').attr('href');
            const excerpt = $(el).find('.entry-content p').first().text().trim().substring(0, 200);
            const date = $(el).find('.entry-date').text().trim();

            if (title && link) {
                results.push({
                    number: i + 1,
                    title,
                    link,
                    excerpt: excerpt || 'No description available',
                    date: date || 'Unknown date'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('FitGirl Search Error:', error.message);
        return null;
    }
}

async function extractFuckingFastLinks(gameUrl) {
    try {
        const response = await axiosInstance.get(gameUrl);
        const $ = cheerio.load(response.data);

        let fuckingFastSection = null;
        $('li, div, p').each((i, el) => {
            const text = $(el).text();
            if (text.includes('FuckingFast') || text.includes('fuckingfast')) {
                fuckingFastSection = $(el);
            }
        });

        if (!fuckingFastSection) {
            const allLinks = [];
            $('a[href*="fuckingfast.co"], a[href*="fuckingfast"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('fuckingfast.co')) {
                    allLinks.push(href);
                }
            });
            if (allLinks.length > 0) return allLinks;
            return null;
        }

        const links = [];
        fuckingFastSection.find('a[href*="fuckingfast.co"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !links.includes(href)) {
                links.push(href);
            }
        });

        $('a[href*="paste.fitgirl-repacks.site"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !links.includes(href)) {
                links.push(href);
            }
        });

        if (links.length === 0) {
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('fuckingfast.co') && !links.includes(href)) {
                    links.push(href);
                }
            });
        }

        return links.length > 0 ? links : null;
    } catch (error) {
        console.error('Extract Links Error:', error.message);
        return null;
    }
}

async function extractLinksFromPaste(pasteUrl) {
    try {
        const response = await axiosInstance.get(pasteUrl);
        const $ = cheerio.load(response.data);

        const links = [];
        $('a[href*="fuckingfast.co"], li').each((i, el) => {
            const href = $(el).attr('href') || $(el).text();
            if (href && href.includes('fuckingfast.co') && !links.includes(href)) {
                links.push(href.trim());
            }
        });

        const pageText = $('body').text();
        const urlRegex = /https?:\/\/fuckingfast\.co\/[^\s\]\)<>"]+/g;
        const foundUrls = pageText.match(urlRegex) || [];
        foundUrls.forEach(url => {
            if (!links.includes(url)) links.push(url);
        });

        return links.length > 0 ? links : null;
    } catch (error) {
        console.error('Paste Extract Error:', error.message);
        return null;
    }
}

async function extractRealDownloadUrl(fuckingFastUrl) {
    try {
        const response = await axiosInstance.get(fuckingFastUrl, { maxRedirects: 5 });
        const html = response.data;

        const windowOpenMatch = html.match(/window\.open\(["'](https?:\/\/[^"']+)["']/);
        if (windowOpenMatch) return windowOpenMatch[1];

        const atobMatch = html.match(/atob\(["']([^"']+)["']\)/);
        if (atobMatch) {
            try {
                const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
                if (decoded.startsWith('http')) return decoded;
            } catch (e) {}
        }

        const dlMatch = html.match(/https:\/\/dl\.fuckingfast\.co\/[^"'\s\]\)<>]+/);
        if (dlMatch) return dlMatch[0];

        const $ = cheerio.load(html);
        let realUrl = null;

        $('script').each((i, el) => {
            const scriptContent = $(el).html();
            if (scriptContent) {
                const woMatch = scriptContent.match(/window\.open\(["'](https?:\/\/[^"']+)["']/);
                if (woMatch && !realUrl) realUrl = woMatch[1];

                const atobMatch2 = scriptContent.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
                if (atobMatch2 && !realUrl) {
                    try {
                        const decoded = Buffer.from(atobMatch2[1], 'base64').toString('utf-8');
                        if (decoded.startsWith('http')) realUrl = decoded;
                    } catch (e) {}
                }

                const urlMatch = scriptContent.match(/https:\/\/dl\.fuckingfast\.co\/[^"'\s\]\)<>]+/);
                if (urlMatch && !realUrl) realUrl = urlMatch[0];
            }
        });

        return realUrl;
    } catch (error) {
        console.error('Real URL Extract Error:', error.message);
        return null;
    }
}

function extractFilenameFromUrl(url) {
    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
        return url.substring(hashIndex + 1);
    }
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        return pathParts[pathParts.length - 1] || 'unknown_file';
    } catch (e) {
        return 'unknown_file';
    }
}

function isValidGamePartLink(url) {
    if (!url || !url.startsWith('https://fuckingfast.co/')) return false;
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) return false;
    const fileName = url.substring(hashIndex + 1);
    const validExtensions = ['.rar', '.bin', '.zip', '.7z', '.iso', '.dmg', '.exe', '.zipx'];
    const hasValidExt = validExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
    if (!hasValidExt) return false;
    if (fileName.length < 5) return false;
    return true;
}

function cleanLinks(links) {
    if (!links || !Array.isArray(links)) return [];
    const seen = new Set();
    return links.filter(link => {
        if (!link || typeof link !== 'string') return false;
        const trimmed = link.trim();
        if (seen.has(trimmed)) return false;
        if (!isValidGamePartLink(trimmed)) return false;
        seen.add(trimmed);
        return true;
    });
}

// ═══════════════════════════════════════════════════════════
// 📥 DOWNLOADER & UPLOADER
// ═══════════════════════════════════════════════════════════
async function handleDownloadAndUpload(url, sock, msg, sendToJid, fileNameOverride = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, {
        text: `🔍 𝖱𝖵 𝖦𝖺𝗆𝖾𝗌 Bot ලින්ක් එක පරීක්ෂා කරමින් පවතී...`
    }, { quoted: msg });

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
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 300000,
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
        const writer = fs.createWriteStream(tempFilePath, { highWaterMark: 64 * 1024 });

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

        if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, {
            text: `🎉 *${fileName}* සාර්ථකව යවන ලදී!\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`,
            edit: progressMsg.key
        }).catch(() => {});

        return { success: true, fileName };

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
        await sock.sendMessage(chatJid, {
            text: `❌ දෝෂයක්: ෆයිල් එක ලබා ගැනීමට නොහැකි විය.`,
            edit: progressMsg.key
        }).catch(() => {});
        return { success: false, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════
// 🤖 FITGIRL LINKS PROCESSORS
// ═══════════════════════════════════════════════════════════
async function processFitGirlLinks(sock, msg, sendToJid, links, gameTitle, chatJid) {
    const startTime = Date.now();
    let uploadedCount = 0;
    let wasStopped = false;
    const totalParts = links.length;

    const initialMsg = await sock.sendMessage(chatJid, {
        text: `🎮 *${gameTitle}*\n📦 *Total Parts:* ${totalParts}\n\n⏳ Downloading parts one by one...\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`
    });

    for (let i = 0; i < links.length; i++) {
        const fuckingFastUrl = links[i];
        const fileName = extractFilenameFromUrl(fuckingFastUrl);

        await sock.sendMessage(chatJid, {
            text: `📥 Part ${i + 1}/${totalParts}: *${fileName}*\n⏳ Real download URL සොයමින්...`,
            edit: initialMsg.key
        }).catch(() => {});

        const realUrl = await extractRealDownloadUrl(fuckingFastUrl);
        if (!realUrl) {
            await sock.sendMessage(chatJid, {
                text: `❌ Part ${i + 1}/${totalParts} (${fileName}): Real download URL සොයාගත නොහැකි විය.`
            });
            continue;
        }

        const result = await handleDownloadAndUpload(realUrl, sock, msg, sendToJid, fileName);

        if (result === 'STOPPED') {
            wasStopped = true;
            break;
        }

        if (result && result.success) {
            uploadedCount++;
        }

        if (i < links.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
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
            `│ 📦 Total Parts: ${uploadedCount}/${totalParts}\n` +
            `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
            `└────────────────────────\n\n` +
            `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

        await sock.sendMessage(chatJid, { text: summaryText });
    } else if (wasStopped) {
        await sock.sendMessage(chatJid, {
            text: `🛑 *ක්‍රියාවලිය නවත්වන ලදී.*\n✅ Uploaded: ${uploadedCount}/${totalParts}`
        });
    }

    userPartLinks.delete(chatJid);
}

async function processFitGirlLinksGroup(sock, msg, groupName, links, gameTitle, chatJid) {
    const initialNotify = await sock.sendMessage(chatJid, {
        text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...`
    });

    try {
        const groups = await sock.groupFetchAllParticipating();
        let targetGroupJid = null;

        for (let jid in groups) {
            if (groups[jid].subject.toLowerCase().includes(groupName.toLowerCase())) {
                targetGroupJid = jid; break;
            }
        }

        if (!targetGroupJid) {
            return await sock.sendMessage(chatJid, {
                text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.'
            });
        }

        const startTime = Date.now();
        let uploadedCount = 0;
        let wasStopped = false;
        const totalParts = links.length;

        await sock.sendMessage(chatJid, {
            text: `🎮 *${gameTitle}*\n📦 *Total Parts:* ${totalParts}\n👥 *Target:* ${groups[targetGroupJid].subject}\n\n⏳ Downloading parts one by one...`,
            edit: initialNotify.key
        });

        for (let i = 0; i < links.length; i++) {
            const fuckingFastUrl = links[i];
            const fileName = extractFilenameFromUrl(fuckingFastUrl);

            const realUrl = await extractRealDownloadUrl(fuckingFastUrl);
            if (!realUrl) {
                await sock.sendMessage(chatJid, {
                    text: `❌ Part ${i + 1}/${totalParts} (${fileName}): Real download URL සොයාගත නොහැකි විය.`
                });
                continue;
            }

            const result = await handleDownloadAndUpload(realUrl, sock, msg, targetGroupJid, fileName);

            if (result === 'STOPPED') {
                wasStopped = true;
                break;
            }

            if (result && result.success) {
                uploadedCount++;
            }

            if (i < links.length - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
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
                `│ 📦 Total Parts: ${uploadedCount}/${totalParts}\n` +
                `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                `└────────────────────────\n\n` +
                `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

            await sock.sendMessage(targetGroupJid, { text: summaryText });
            await sock.sendMessage(chatJid, {
                text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`,
                edit: initialNotify.key
            });
        } else if (wasStopped) {
            await sock.sendMessage(chatJid, {
                text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*\n✅ Uploaded: ${uploadedCount}/${totalParts}`,
                edit: initialNotify.key
            });
        }

        userPartLinks.delete(chatJid);

    } catch (error) {
        await sock.sendMessage(chatJid, {
            text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.'
        });
    }
}

// ═══════════════════════════════════════════════════════════
// 🤖 MAIN BOT START
// ═══════════════════════════════════════════════════════════
const userSearchResults = new Map();
const userPartLinks = new Map();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        msgRetryCounterCache,
        markOnlineOnConnect: true,
        getMessage: getMessageFromStore,
        cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid)
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('groups.upsert', (groups) => {
        for (const group of groups) {
            groupMetadataCache.set(group.id, group);
        }
    });

    sock.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            if (update.id) {
                try {
                    const metadata = await sock.groupMetadata(update.id);
                    groupMetadataCache.set(update.id, metadata);
                } catch (e) {}
            }
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        try {
            const metadata = await sock.groupMetadata(event.id);
            groupMetadataCache.set(event.id, metadata);
        } catch (e) {}
    });

    // ═══════════════════════════════════════════════════════════
    // 📨 MESSAGE HANDLER
    // ═══════════════════════════════════════════════════════════
    sock.ev.on('messages.upsert', async m => {
        m.messages.forEach(msg => {
            storeMessage(msg);
        });

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption ||
                     msg.message?.videoMessage?.caption ||
                     "";
        const trimmedText = text.trim();

        const senderJid = msg.key.participant || msg.key.remoteJid || "";
        const chatJid = msg.key.remoteJid;

        // ═══════════════════════════════════════════════════════════
        // 🔒 AUTHORIZATION CHECK
        // ═══════════════════════════════════════════════════════════
        if (!isAuthorized(senderJid)) {
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
        const storedData = userPartLinks.get(chatJid);

        // ═══════════════════════════════════════════════════════════
        // 🔢 PRIORITY 1: NUMBER REPLY (FitGirl Search Results)
        // ═══════════════════════════════════════════════════════════
        if (/^\d+$/.test(trimmedText) && userSearchResults.has(chatJid)) {
            const searchData = userSearchResults.get(chatJid);
            const selectedNum = parseInt(trimmedText);
            const selectedResult = searchData.results.find(r => r.number === selectedNum);

            if (!selectedResult) {
                return await sock.sendMessage(chatJid, {
                    text: `❌ වලංගු result number එකක් නොවේ. 1 සිට ${searchData.results.length} දක්වා උත්සාහ කරන්න.`
                }, { quoted: msg });
            }

            const fetchingMsg = await sock.sendMessage(chatJid, {
                text: `🔍 "*${selectedResult.title}*" එකේ download links සොයමින් පවතී...`
            }, { quoted: msg });

            try {
                let links = await extractFuckingFastLinks(selectedResult.link);

                if (!links || links.length === 0) {
                    const pageResponse = await axiosInstance.get(selectedResult.link);
                    const $ = cheerio.load(pageResponse.data);
                    const pasteLinks = [];
                    $('a[href*="paste.fitgirl-repacks.site"]').each((i, el) => {
                        pasteLinks.push($(el).attr('href'));
                    });

                    if (pasteLinks.length > 0) {
                        for (const pasteUrl of pasteLinks) {
                            const pasteLinks2 = await extractLinksFromPaste(pasteUrl);
                            if (pasteLinks2) {
                                links = pasteLinks2;
                                break;
                            }
                        }
                    }
                }

                if (!links || links.length === 0) {
                    return await sock.sendMessage(chatJid, {
                        text: `❌ "*${selectedResult.title}*" එකේ FuckingFast links සොයාගත නොහැකි විය.\nමෙම game එකට direct links නැත හෝ site structure එක වෙනස් වී ඇත.`,
                        edit: fetchingMsg.key
                    });
                }

                userPartLinks.set(chatJid, {
                    links: links,
                    gameTitle: selectedResult.title
                });

                const fileNames = links.map((url, i) => {
                    const fileName = extractFilenameFromUrl(url);
                    return `${i + 1}. ${fileName}`;
                });

                let linksText = `🎮 *${selectedResult.title}*\n\n`;
                linksText += `📦 *Total Parts:* ${links.length}\n\n`;
                linksText += `╔══════════════════════════════════════╗\n`;
                linksText += `┃ *Download Parts:*\n`;
                linksText += `╠══════════════════════════════════════╣\n`;

                fileNames.forEach(name => {
                    const displayName = name.length > 50 ? name.substring(0, 47) + '...' : name;
                    linksText += `┃ ${displayName}\n`;
                });

                linksText += `╚══════════════════════════════════════╝\n\n`;
                linksText += `📌 *Download all parts:*\n`;
                linksText += `├─ Reply \`.si\` → Inbox එකට එවයි\n`;
                linksText += `├─ Reply \`.sg [group name]\` → Group එකට එවයි\n`;
                linksText += `└─ Reply \`.stop\` → නවත්වන්න\n\n`;
                linksText += `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, {
                    text: linksText,
                    edit: fetchingMsg.key
                });

            } catch (error) {
                console.error('Number Reply Error:', error);
                await sock.sendMessage(chatJid, {
                    text: `❌ Links සොයාගැනීමේ දෝෂයකි: ${error.message}`,
                    edit: fetchingMsg.key
                });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 📥 PRIORITY 2: .si with Stored FitGirl Links (NO URLs)
        // ═══════════════════════════════════════════════════════════
        if (storedData && trimmedText === '.si' && urls.length === 0) {
            await processFitGirlLinks(sock, msg, senderJid, storedData.links, storedData.gameTitle, chatJid);
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 👥 PRIORITY 3: .sg with Stored FitGirl Links (NO URLs)
        // ═══════════════════════════════════════════════════════════
        if (storedData && trimmedText.startsWith('.sg ') && urls.length === 0) {
            let groupName = trimmedText.replace('.sg ', '').trim();
            if (!groupName) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න. උදා: .sg pro games' }, { quoted: msg });
            }
            await processFitGirlLinksGroup(sock, msg, groupName, storedData.links, storedData.gameTitle, chatJid);
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 🛑 PRIORITY 4: .stop Command
        // ═══════════════════════════════════════════════════════════
        if (trimmedText === '.stop') {
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
                await sock.sendMessage(chatJid, {
                    text: '✅ සියලුම සක්‍රීය ඩවුන්ලෝඩ්/අප්ලෝඩ් ක්‍රියාවලීන් නතර කර දත්ත ඉවත් කරන ලදී!'
                }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, {
                    text: '❌ මේ මොහොතේ කිසිදු ෆයිල් එකක් බාගත වෙමින් පවතින්නේ නැත.'
                }, { quoted: msg });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // ❌ BLOCK: Non-dot commands (after priority checks)
        // ═══════════════════════════════════════════════════════════
        if (!trimmedText.startsWith('.')) return;

        // ═══════════════════════════════════════════════════════════
        // 🎮 .fg COMMAND - FitGirl Repacks Search
        // ═══════════════════════════════════════════════════════════
        if (trimmedText.startsWith('.fg ')) {
            const gameName = trimmedText.replace('.fg ', '').trim();
            if (!gameName) {
                return await sock.sendMessage(chatJid, {
                    text: '❌ කරුණාකර game එකේ නම ලබා දෙන්න.\nඋදා: `.fg Far Cry 3`'
                }, { quoted: msg });
            }

            const searchingMsg = await sock.sendMessage(chatJid, {
                text: `🔍 *FitGirl Repacks* වලින් "*${gameName}*" සොයමින් පවතී...`
            }, { quoted: msg });

            try {
                const results = await searchFitGirl(gameName);

                if (!results || results.length === 0) {
                    return await sock.sendMessage(chatJid, {
                        text: `❌ "*${gameName}*" සඳහා FitGirl Repacks වලින් results නැත.\nවෙනත් නමකින් උත්සාහ කරන්න.`,
                        edit: searchingMsg.key
                    });
                }

                userSearchResults.set(chatJid, {
                    results: results,
                    timestamp: Date.now()
                });

                let resultsText = `🎮 *FitGirl Repacks Search Results*\n\n`;
                resultsText += `🔍 *Query:* "${gameName}"\n`;
                resultsText += `📊 *Found:* ${results.length} results\n\n`;
                resultsText += `╔══════════════════════════════════════╗\n`;

                results.forEach((r, i) => {
                    resultsText += `┃ *${r.number}.* ${r.title}\n`;
                    resultsText += `┃ 📅 ${r.date}\n`;
                    resultsText += `┃ 📝 ${r.excerpt}\n`;
                    if (i < results.length - 1) resultsText += `┃ ──────────────────────────────────\n`;
                });

                resultsText += `╚══════════════════════════════════════╝\n\n`;
                resultsText += `📌 *Reply with the number* to get download links.\n`;
                resultsText += `📌 උදා: reply with \`1\` for first result\n\n`;
                resultsText += `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, {
                    text: resultsText,
                    edit: searchingMsg.key
                });

            } catch (error) {
                console.error('.fg Error:', error);
                await sock.sendMessage(chatJid, {
                    text: `❌ FitGirl search දෝෂයකි: ${error.message}`,
                    edit: searchingMsg.key
                });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 📥 .si COMMAND (with URLs in text)
        // ═══════════════════════════════════════════════════════════
        if (trimmedText.startsWith('.si ')) {
            if (urls.length === 0) {
                return await sock.sendMessage(chatJid, {
                    text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.'
                }, { quoted: msg });
            }

            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break;
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 👥 .sg COMMAND (with URLs in text)
        // ═══════════════════════════════════════════════════════════
        if (trimmedText.startsWith('.sg ')) {
            if (urls.length === 0) {
                return await sock.sendMessage(chatJid, {
                    text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.'
                }, { quoted: msg });
            }

            let groupName = trimmedText.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) {
                return await sock.sendMessage(chatJid, {
                    text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න.'
                }, { quoted: msg });
            }

            const initialNotify = await sock.sendMessage(chatJid, {
                text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...`
            });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) {
                    return await sock.sendMessage(chatJid, {
                        text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.'
                    });
                }

                const startTime = Date.now();
                let uploadedCount = 0;
                let wasStopped = false;

                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (success && success.success) uploadedCount++;
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
                    await sock.sendMessage(chatJid, {
                        text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`,
                        edit: initialNotify.key
                    });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, {
                        text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*`,
                        edit: initialNotify.key
                    });
                }

            } catch (error) {
                await sock.sendMessage(chatJid, {
                    text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.'
                });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // ⚡ .speed COMMAND
        // ═══════════════════════════════════════════════════════════
        if (trimmedText === '.speed') {
            await sock.sendMessage(chatJid, {
                text: '⚡ RV Games සර්වර් වේගය පරීක්ෂා කරමින් පවතී...'
            }, { quoted: msg });
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

                await sock.sendMessage(chatJid, { text: speedText }, { quoted: msg });
            } catch (error) {
                console.error("Speed test Error:", error.message);
                await sock.sendMessage(chatJid, {
                    text: `❌ Speed test දෝෂයකි: ${error.message}`
                }, { quoted: msg });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 🧹 .dc COMMAND (Disk Cleaner)
        // ═══════════════════════════════════════════════════════════
        if (trimmedText === '.dc') {
            await sock.sendMessage(chatJid, {
                text: '🧹 RV Games සර්වර් එකේ තාවකාලික ෆයිල් ඉවත් කරමින් පවතී...'
            }, { quoted: msg });
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

                await sock.sendMessage(chatJid, { text: clearText }, { quoted: msg });
            } catch (error) {
                console.error("Disk Cleaner Error:", error.message);
                await sock.sendMessage(chatJid, {
                    text: `❌ Disk එක Clear කිරීමේදී දෝෂයක් ඇති විය: ${error.message}`
                }, { quoted: msg });
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 💀 .crash COMMAND
        // ═══════════════════════════════════════════════════════════
        if (trimmedText === '.crash') {
            await sock.sendMessage(chatJid, {
                text: '💀 *RV Games Bot Offline කරනු ලදී.*\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._'
            }, { quoted: msg });
            console.log("💀 Manual Crash triggered: Bot stopped.");
            setTimeout(() => {
                process.exit(0);
            }, 1000);
            return;
        }

        // ═══════════════════════════════════════════════════════════
        // 📜 .menu COMMAND
        // ═══════════════════════════════════════════════════════════
        if (trimmedText === '.menu') {
            const menuText =
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃    🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 🎮 *.fg [game name]*\n` +
                `┃ ↳ _FitGirl Repacks වලින් game search කරයි._\n` +
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
            return;
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            for (const [jid, task] of activeTasks.entries()) {
                task.controller.abort();
                if (task.uploadInterval) clearInterval(task.uploadInterval);
                if (task.stream) try { task.stream.destroy(); } catch(e){}
                if (task.writer) try { task.writer.destroy(); } catch(e){}
                if (task.tempFilePath && fs.existsSync(task.tempFilePath)) {
                    try { fs.unlinkSync(task.tempFilePath); } catch(e){}
                }
            }
            activeTasks.clear();
            userSearchResults.clear();
            userPartLinks.clear();

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
