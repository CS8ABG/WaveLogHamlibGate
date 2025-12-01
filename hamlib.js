const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const unzipper = require('unzipper');
const os = require('os');

let hamlibProcess = null;
let hamlibBinPath = null;

const HAMLIB_DIR = path.join(require('electron').app.getPath("userData"), "hamlib");
const activeConnections = new Set();

function ensureHamlibDir() {
    if (!fs.existsSync(HAMLIB_DIR)) {
        fs.mkdirSync(HAMLIB_DIR, { recursive: true });
    }
}

function findRigctld(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isFile() && file.name.toLowerCase() === 'rigctld.exe') {
            return fullPath;
        } else if (file.isDirectory()) {
            const found = findRigctld(fullPath);
            if (found) return found;
        }
    }
    return null;
}

async function unpackHamlib(zipPath) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
            .pipe(unzipper.Parse())
            .on('entry', function(entry) {
                const fileName = entry.path;
                const type = entry.type;
                const flattenedName = path.basename(fileName);
                const outputPath = path.join(HAMLIB_DIR, flattenedName);
                if (type === 'File') {
                    entry.pipe(fs.createWriteStream(outputPath));
                } else {
                    entry.autodrain();
                }
            })
            .on('close', resolve)
            .on('error', reject);
    });
}

function spawnCommandAndCollect(cmd, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let out = '';
        let err = '';
        child.stdout.on('data', d => out += d.toString());
        child.stderr.on('data', d => err += d.toString());
        child.on('close', code => {
            if (code === 0 || out) resolve(out + (err ? '\n' + err : ''));
            else reject(new Error('process exited with code ' + code + ' ' + err));
        });
        child.on('error', e => reject(e));
    });
}

// ===================== HAMLIB INSTALLATION =====================
async function hamlib_download() {
    ensureHamlibDir();
    const platform = process.platform;

    // 1. LINUX
    if (platform === "linux") {
        try {
            execSync("which apt-get", { stdio: "ignore" });
            execSync("sudo apt-get update", { stdio: "inherit" });
            execSync("sudo apt-get install -y libhamlib-utils", { stdio: "inherit" });

            const rigPath = "/usr/bin/rigctld";
            if (!fs.existsSync(rigPath)) throw new Error("rigctld not found");

            hamlibBinPath = path.dirname(rigPath);
            const out = await spawnCommandAndCollect(rigPath, ["--version"]);
            return {
                success: true,
                folder: hamlibBinPath,
                version: out.match(/Hamlib\s+([\d\.]+)/i)?.[1] || null,
                source: "apt"
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // 2. macOS
    if (platform === "darwin") {
        try {
            execSync("which brew", { stdio: "ignore" });
            execSync("brew install hamlib", { stdio: "inherit" });

            const rigPath = fs.existsSync("/usr/local/bin/rigctld") ? "/usr/local/bin/rigctld" : "/opt/homebrew/bin/rigctld";
            if (!fs.existsSync(rigPath)) throw new Error("rigctld not found");

            hamlibBinPath = path.dirname(rigPath);
            const out = await spawnCommandAndCollect(rigPath, ["--version"]);
            return {
                success: true,
                folder: hamlibBinPath,
                version: out.match(/Hamlib\s+([\d\.]+)/i)?.[1] || null,
                source: "brew"
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // 3. WINDOWS
    try {
        const api = await fetch("https://api.github.com/repos/Hamlib/Hamlib/releases/latest", {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!api.ok) throw new Error("GitHub API request failed");

        const json = await api.json();
        const asset = json.assets.find(a => a.name.includes("w64") && a.name.endsWith(".zip"));
        if (!asset) throw new Error("No Windows Hamlib build found");

        const zipPath = path.join(HAMLIB_DIR, asset.name);
        const res = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) throw new Error("Failed to download ZIP");

        const fileStream = fs.createWriteStream(zipPath);
        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });

        await unpackHamlib(zipPath);
        const rigPath = findRigctld(HAMLIB_DIR);
        if (!rigPath) throw new Error("rigctld.exe not found after extraction");

        hamlibBinPath = path.dirname(rigPath);
        const out = await spawnCommandAndCollect(rigPath, ["--version"]);
        return { success: true, zip: zipPath, folder: HAMLIB_DIR, version: out.match(/Hamlib\s+([\d\.]+)/i)?.[1] || null, source: "github" };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ===================== HAMLIB VERSION =====================
async function hamlib_get_version() {
    try {
        let exe = null;
        if (hamlibBinPath) {
            exe = path.join(hamlibBinPath, process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
        }
        if (!exe || !fs.existsSync(exe)) {
            if (process.platform === "win32") {
                const rigPath = findRigctld(HAMLIB_DIR);
                if (rigPath) {
                    hamlibBinPath = path.dirname(rigPath);
                    exe = rigPath;
                }
            }
        }
        if (!exe || !fs.existsSync(exe)) {
            try {
                const which = execSync("which rigctld", { encoding: "utf8" }).trim();
                if (which && fs.existsSync(which)) {
                    exe = which;
                    hamlibBinPath = path.dirname(which);
                }
            } catch (_) {}
        }
        if (process.platform === "darwin" && (!exe || !fs.existsSync(exe))) {
            const brewPaths = ["/usr/local/bin/rigctld", "/opt/homebrew/bin/rigctld"];
            for (const p of brewPaths) {
                if (fs.existsSync(p)) {
                    exe = p;
                    hamlibBinPath = path.dirname(p);
                    break;
                }
            }
        }
        if (!exe || !fs.existsSync(exe)) return { installed: false };
        const out = await spawnCommandAndCollect(exe, ['--version']);
        const match = out.match(/Hamlib\s+([\d\.]+)/i);
        return { installed: true, raw: out, version: match ? match[1] : null, exe };
    } catch (e) {
        return { installed: false, error: e.message };
    }
}

// ===================== LIST RADIOS =====================
async function hamlib_list() {
    try {
        if (!hamlibBinPath) return { ok: false, reason: 'hamlib not installed' };
        const exe = path.join(hamlibBinPath, process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
        const out = await spawnCommandAndCollect(exe, ['--list']);
        const lines = out.split(/\r?\n/);
        const list = [];
        for (const ln of lines) {
            const m = ln.match(/^\s*(\d+)\s+(.{1,24}?)\s{2,}(.+?)\s+(\d+\.\d+)/);
            if (m) {
                const id = Number(m[1]);
                const mfg = m[2].trim();
                const model = m[3].trim();
                list.push({ id, mfg, model });
            }
        }
        return { ok: true, list };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// ===================== START/STOP RIGCTLD =====================
async function hamlib_start_rigctld(opts) {
    try {
        if (!hamlibBinPath) throw new Error('hamlib not installed');
        if (hamlibProcess) return { ok:false, reason:'already running' };

        const exe = path.join(hamlibBinPath, process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
        const args = [`--model=${opts.model}`, `--rig-file=${opts.rigFile}`, `--serial-speed=${opts.baud}`];
        if (opts.civ) args.push(`--civaddr=${opts.civ}`);
        if (opts.pttFile && opts.pttType) { args.push(`--ptt-file=${opts.pttFile}`, `--ptt-type=${opts.pttType}`); }
        args.push(`--port=4532`, '-vv');

        const child = spawn(exe, args, { windowsHide: true });
        hamlibProcess = child;
        activeConnections.add(child);

        child.stdout.on('data', d => console.log('rigctld stdout:', d.toString()));
        child.stderr.on('data', d => console.error('rigctld stderr:', d.toString()));
        child.on('close', code => { hamlibProcess = null; activeConnections.delete(child); console.log('rigctld exited', code); });
        child.on('error', err => { activeConnections.delete(child); console.error('rigctld start error', err); });

        return { ok:true, pid: child.pid };
    } catch (e) {
        return { ok:false, reason: e.message };
    }
}

async function hamlib_stop() {
    try {
        if (hamlibProcess) { hamlibProcess.kill(); hamlibProcess = null; }
        activeConnections.forEach(conn => { try { conn.kill && conn.kill(); } catch(e) {} });
        return { ok:true };
    } catch (e) {
        return { ok:false, reason: e.message };
    }
}

// ===================== SERIAL PORT ENUMERATION =====================
async function hamlib_get_serialports() {
    const ports = [];
    if (process.platform === 'win32') {
        try {
            const SerialPort = require('serialport');
            const list = await SerialPort.list();
            for (const p of list) ports.push({ path: p.path, friendly: p.friendlyName || p.path });
        } catch (e) {
            try {
                const reg = execSync("reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM", { encoding: "utf8" });
                for (const line of reg.split(/\r?\n/)) {
                    const m = line.match(/REG_SZ\s+(.+)/);
                    if (m) ports.push({ path: m[1], friendly: m[1] });
                }
            } catch (_) {}
        }
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
        const devDir = '/dev';
        const patterns = process.platform === 'darwin' ? [/^tty\./, /^cu\./] : [/^ttyS/, /^ttyUSB/, /^ttyACM/];
        try {
            const files = fs.readdirSync(devDir);
            for (const f of files) {
                if (patterns.some(p => p.test(f))) ports.push({ path: path.join(devDir, f), friendly: f });
            }
        } catch (e) { console.warn('Failed to read /dev:', e); }

        try {
            const SerialPort = require('serialport');
            const list = await SerialPort.list();
            for (const p of list) {
                if (!ports.find(x => x.path === p.path)) ports.push({ path: p.path, friendly: p.friendlyName || p.path });
            }
        } catch (_) {}
    }

    return ports;
}

module.exports = {
    hamlib_download,
    hamlib_get_version,
    hamlib_list,
    hamlib_start_rigctld,
    hamlib_stop,
    hamlib_get_serialports,
    hamlibProcess,
    activeConnections,
    HAMLIB_DIR
};
