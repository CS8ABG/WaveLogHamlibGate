const {app, BrowserWindow, globalShortcut, Notification, powerSaveBlocker } = require('electron/main');
const path = require('node:path');
const {ipcMain} = require('electron')
const http = require('http');
const xml = require("xml2js");
const net = require('net');
const WebSocket = require('ws');
const udp = require('dgram');
const storage = require('electron-json-storage');

const resizable = process.env.RESIZABLE === 'true' || false;
const gotTheLock = app.requestSingleInstanceLock();
const hamlib = require('./hamlib');

let powerSaveBlockerId;
let s_mainWindow;
let msgbacklog=[];
let httpServer;
let currentCAT=null;
var WServer;
let wsServer;
let wsClients = new Set();
let isShuttingDown = false;
let activeConnections = new Set(); 
let activeHttpRequests = new Set();

const DemoAdif='<call:5>N0CALL <gridsquare:4>HM77 <mode:3>FT4 <rst_sent:3>-12 <rst_rcvd:2>10 <qso_date:8>20250101 <time_on:6>123059 <qso_date_off:8>20250101 <time_off:6>123059 <band:3>160m <freq:8>1.800100 <station_callsign:5>TE1ST <my_gridsquare:6>HM77OO <eor>';

if (require('electron-squirrel-startup')) app.quit();

let defaultcfg = {
	wavelog_url: "https://wavelog.server/index.php",
	wavelog_key: "my-api-key",
	wavelog_id: "0",
	wavelog_radioname: 'Station',
	wavelog_cat_url: 'http://127.0.0.1:54321',
	trx_poll: 1000,
	hamlib_model: 'none',
	hamlib_com: 'none',
	hamlib_baud: '9600',
	hamlib_civ: ' ',
	hamlib_extptt: false,
	hamlib_ptt_com: 'none',
	hamlib_ptt_type: 'RTS',
	hamlib_autostart: false,
}

app.disableHardwareAcceleration(); 

function createWindow () {
	const mainWindow = new BrowserWindow({
		width: 525,
		height: 790,
		resizable: resizable, // Default: false, can be overwritten with RESIZABLE
		autoHideMenuBar: app.isPackaged,
		webPreferences: {
			contextIsolation: false,
			backgroundThrottling: false,
			nodeIntegration: true,
			devTools: !app.isPackaged,
			enableRemoteModule: true,
			preload: path.join(__dirname, 'preload.js')
		}
	});
	if (app.isPackaged) {
		mainWindow.setMenu(null);
	}

	mainWindow.loadFile('index.html')
	mainWindow.setTitle(require('./package.json').name + " V" + require('./package.json').version);

	return mainWindow;
}

//HAMLIB: Handlers
ipcMain.handle("hamlib_download", async () => { return await hamlib.hamlib_download();});
ipcMain.handle("hamlib_get_version", async () => { return await hamlib.hamlib_get_version();});
ipcMain.handle("hamlib_list", async () => { return await hamlib.hamlib_list();});
ipcMain.handle("hamlib_start_rigctld", async (_event, opts) => { return await hamlib.hamlib_start_rigctld(opts);});
ipcMain.handle("hamlib_stop", async () => { return await hamlib.hamlib_stop();});
ipcMain.handle("hamlib_get_serialports", async () => { return await hamlib.hamlib_get_serialports();});

ipcMain.on("set_config", async (event,arg) => {
	defaultcfg=arg;
	storage.set('basic', defaultcfg, function(e) {
		if (e) throw e;
	});
	event.returnValue=defaultcfg;
});

ipcMain.on("resize", async (event,arg) => {
	const newsize=arg;
	s_mainWindow.setContentSize(newsize.width,newsize.height,newsize.ani);
	s_mainWindow.setSize(newsize.width,newsize.height,newsize.ani);
	s_mainWindow.center();
	event.returnValue=true;
});

ipcMain.on("get_config", (event, arg) => {
    let storedcfg;

    try {
        storedcfg = storage.getSync('basic');
    } catch (e) {
        storedcfg = {};
    }

    let realcfg = {};

    if (!storedcfg.wavelog_url && !storedcfg.profiles) {
        realcfg = defaultcfg;
    } else if (!storedcfg.profiles) {
        realcfg.profiles = [storedcfg, defaultcfg];
        realcfg.profile = storedcfg.profile ?? 0;
    } else {
        realcfg = storedcfg;
    }

    if (arg !== undefined && arg !== '') {
        realcfg.profile = arg;
    }

    defaultcfg = realcfg;

    event.returnValue = realcfg;
});

ipcMain.on("setCAT", async (event,arg) => {
	settrx(arg);
	event.returnValue=true;
});

ipcMain.on("quit", async (event,arg) => {
	console.log('Quit requested from renderer');
	shutdownApplication();
	app.quit();
	event.returnValue=true;
});

ipcMain.on("radio_status_update", async (event,arg) => {
	broadcastRadioStatus(arg);
	event.returnValue=true;
});

function shutdownApplication() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('Initiating application shutdown...');

    try {
        if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
            powerSaveBlocker.stop(powerSaveBlockerId);
            console.log('Power save blocker stopped.');
        }
    } catch (e) {
        console.error('Error stopping power save blocker:', e);
    }

    try {
        if (s_mainWindow && !s_mainWindow.isDestroyed()) {
            s_mainWindow.webContents.send('cleanup');
            console.log('Sent cleanup signal to renderer.');
        }
    } catch (e) {
        console.error('Error sending cleanup to renderer:', e);
    }

    try {
        hamlib.hamlib_stop();
        console.log('Hamlib rig stopped.');
    } catch (e) {
        console.error('Error stopping Hamlib:', e);
    }

    activeConnections.forEach(conn => {
        try {
            if (conn && !conn.destroyed) conn.destroy();
        } catch (e) {
            console.error('Error closing TCP connection:', e);
        }
    });
    activeConnections.clear();
    console.log('All TCP connections closed.');

    activeHttpRequests.forEach(req => {
        try {
            req.abort();
        } catch (e) {
            console.error('Error aborting HTTP request:', e);
        }
    });
    activeHttpRequests.clear();
    console.log('All HTTP requests aborted.');

    try {
        if (WServer) {
            WServer.close(() => console.log('UDP server closed.'));
        }
    } catch (e) {
        console.error('Error closing UDP server:', e);
    }

    try {
        if (httpServer) {
            httpServer.close(() => console.log('HTTP server closed.'));
        }
    } catch (e) {
        console.error('Error closing HTTP server:', e);
    }

    try {
        if (wsServer) {
            wsClients.forEach(client => {
                try {
                    if (client.readyState === WebSocket.OPEN) client.close();
                } catch (e) {
                    console.error('Error closing WebSocket client:', e);
                }
            });
            wsClients.clear();
            wsServer.close(() => console.log('WebSocket server closed.'));
        }
    } catch (e) {
        console.error('Error closing WebSocket server:', e);
    }

    console.log('Shutdown complete.');
}

function show_noti(arg) {
	if (Notification.isSupported()) {
		try {
			const notification = new Notification({
				title: 'Wavelog Gateway',
				body: arg
			});
			notification.show();
		} catch(e) {
			console.log("No notification possible on this system / ignoring");
		}
	} else {
		console.log("Notifications are not supported on this platform");
	}
}

ipcMain.on("test", async (event,arg) => {
	
	let result={};
	let plain;
	try {
		plain=await send2wavelog(arg,DemoAdif, true);
	} catch (e) {
		plain=e;
		console.log(plain);
	} finally {
		try {
			result.payload=JSON.parse(plain.resString);
		} catch (ee) {
			result.payload=plain.resString;
		} finally {
			result.statusCode=plain.statusCode;
			event.returnValue=result;
		}
	}
});

app.on('before-quit', () => {
    console.log('before-quit event triggered');
    shutdownApplication();
});

process.on('SIGINT', () => {
    console.log('SIGINT received, initiating shutdown...');
    shutdownApplication();
    process.exit(0);
});

app.on('will-quit', () => {
	try {
		powerSaveBlocker.stop(powerSaveBlockerId);
	} catch(e) {
		console.log(e);
	}
});

if (!gotTheLock) {
	app.quit();
} else {
	startserver();
	app.whenReady().then(() => {
		powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
		s_mainWindow=createWindow();
		globalShortcut.register('Control+Shift+I', () => { return false; });
		app.on('activate', function () {
			if (BrowserWindow.getAllWindows().length === 0) createWindow()
		});
		s_mainWindow.webContents.once('dom-ready', function() {
			if (msgbacklog.length>0) {
				s_mainWindow.webContents.send('serviceStatus',msgbacklog);
			}
		});
	});
}

app.on('window-all-closed', function () {
	console.log('All windows closed, initiating shutdown...');
	if (!isShuttingDown) {
		shutdownApplication();
	}
	if (process.platform !== 'darwin') app.quit();
	else app.quit();
})

function normalizeTxPwr(adifdata) {
	return adifdata.replace(/<TX_PWR:(\d+)>([^<]+)/gi, (match, length, value) => {
		const cleanValue = value.trim().toLowerCase();
		
		const numMatch = cleanValue.match(/^(\d+(?:\.\d+)?)/);
		if (!numMatch) return match;
		
		let watts = parseFloat(numMatch[1]);
		
		if (cleanValue.includes('kw')) {
			watts *= 1000;
		} else if (cleanValue.includes('mw')) {
			watts *= 0.001;
		}

		const newValue = watts.toString();
		return `<TX_PWR:${newValue.length}>${newValue}`;
	});
}

function normalizeKIndex(adifdata) {
	return adifdata.replace(/<K_INDEX:(\d+)>([^<]+)/gi, (match, length, value) => {
		const numValue = parseFloat(value.trim());
		if (isNaN(numValue)) return ''; 
		
		let kIndex = Math.round(numValue);
		if (kIndex < 0) kIndex = 0;
		if (kIndex > 9) kIndex = 9;
		
		return `<K_INDEX:${kIndex.toString().length}>${kIndex}`;
	});
}

function manipulateAdifData(adifdata) {
	adifdata = normalizeTxPwr(adifdata);
	adifdata = normalizeKIndex(adifdata);
	return adifdata;
}

function parseADIF(adifdata) {
	const { ADIF } = require("tcadif");
	const normalizedData = manipulateAdifData(adifdata);
	const adiReader = ADIF.parse(normalizedData);
	return adiReader.toObject();
}

function writeADIF(adifObject) {
	const { ADIF } = require("tcadif");
	const adiWriter = new ADIF(adifObject);
	return adiWriter;
}

function freqToBand(freq_mz) {
	const f = parseFloat(freq_mz);
	if (isNaN(f)) return null;

	const bandMap = require('tcadif/lib/enums/Band');
	for (const [band, { lowerFreq, upperFreq }] of Object.entries(bandMap))
		if (f >= parseFloat(lowerFreq) && f <= parseFloat(upperFreq))
			return band;

	return null;
}

function send2wavelog(o_cfg,adif, dryrun = false) {
	let clpayload={};
	clpayload.key=o_cfg.wavelog_key.trim();
	clpayload.station_profile_id=o_cfg.wavelog_id.trim();
	clpayload.type='adif';
	clpayload.string=adif;
	const postData=JSON.stringify(clpayload);
	let httpmod='http';
	if (o_cfg.wavelog_url.toLowerCase().startsWith('https')) {
		httpmod='https';
	}
	const https = require(httpmod);
	const options = {
		method: 'POST',
		timeout: 5000,
		rejectUnauthorized: false,
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': 'SW2WL_v' + app.getVersion(),
			'Content-Length': postData.length
		}
	};

	return new Promise((resolve, reject) => {
		let rej=false;
		let result={};
		let url=o_cfg.wavelog_url + '/api/qso';
		if (dryrun) { url+='/true'; }
		const req = https.request(url,options, (res) => {

			result.statusCode=res.statusCode;
			if (res.statusCode < 200 || res.statusCode > 299) {
				rej=true;
			}

			const body = [];
			res.on('data', (chunk) => body.push(chunk));
			res.on('end', () => {

				activeHttpRequests.delete(req);

				let resString = Buffer.concat(body).toString();
				if (rej) {
					if (resString.indexOf('html>')>0) {
						resString='{"status":"failed","reason":"Wrong WaveLog URL"}';
					}
					result.resString=resString;
					reject(result);
				} else {
					result.resString=resString;
					resolve(result);
				}
			})
		})

		req.on('error', (err) => {
			activeHttpRequests.delete(req);
			rej=true;
			req.destroy();
			result.resString='{"status":"failed","reason":"Check your WaveLog URL / no connection"}';
			reject(result);
		})

		req.on('timeout', (err) => {
			activeHttpRequests.delete(req);
			rej=true;
			req.destroy();
			result.resString='{"status":"failed","reason":"timeout"}';
			reject(result);
		})

		activeHttpRequests.add(req);

		req.write(postData);
		req.end();
	});

}

const ports = [2333];

ports.forEach(port => {
	WServer = udp.createSocket('udp4');
	toservicestatus({service:"udp", status:"running", port:"2333"});
	WServer.on('error', function(err) {
		toservicestatus({service:"udp", status:"blocked", reason:"Port "+port+" in use"});
	});

	WServer.on('message',async function(msg,info){
		let parsedXML={};
		let adobject={};
		if (msg.toString().includes("xml")) {
			try {
				xml.parseString(msg.toString(), function (err,dat) {
					parsedXML=dat;
				});
				let qsodatum = new Date(Date.parse(parsedXML.contactinfo.timestamp[0]+"Z"));
				const qsodat=fmt(qsodatum);
				if (parsedXML.contactinfo.mode[0] == 'USB' || parsedXML.contactinfo.mode[0] == 'LSB') {	
					parsedXML.contactinfo.mode[0]='SSB';
				}
				adobject = { qsos: [
					{ 
						CALL: parsedXML.contactinfo.call[0],
						MODE: parsedXML.contactinfo.mode[0],
						QSO_DATE_OFF: qsodat.d,
						QSO_DATE: qsodat.d,
						TIME_OFF: qsodat.t,
						TIME_ON: qsodat.t,
						RST_RCVD: parsedXML.contactinfo.rcv[0],
						RST_SENT: parsedXML.contactinfo.snt[0],
						FREQ: ((1*parseInt(parsedXML.contactinfo.txfreq[0]))/100000).toString(),
						FREQ_RX: ((1*parseInt(parsedXML.contactinfo.rxfreq[0]))/100000).toString(),
						OPERATOR: parsedXML.contactinfo.operator[0],
						COMMENT: parsedXML.contactinfo.comment[0],
						POWER: parsedXML.contactinfo.power[0],
						STX: parsedXML.contactinfo.sntnr[0],
						RTX: parsedXML.contactinfo.rcvnr[0],
						MYCALL: parsedXML.contactinfo.mycall[0],
						GRIDSQUARE: parsedXML.contactinfo.gridsquare[0],
						STATION_CALLSIGN: parsedXML.contactinfo.mycall[0]
					} ]};
				let band = freqToBand(adobject.qsos[0].FREQ);
				if (band) adobject.qsos[0].BAND = band;
			} catch (e) {}
		} else {
			try {
				adobject=parseADIF(msg.toString());
			} catch(e) {
				toservicestatus({service:"udp", status:"warning", reason:"Received broken ADIF"});
				return;
			}
		}
		let plainret='';
		if (adobject.qsos.length>0) {
			let x={};
			try {
				const outadif=writeADIF(adobject);
				plainret=await send2wavelog(defaultcfg.profiles[defaultcfg.profile ?? 0],outadif.stringify());
				x.state=plainret.statusCode;
				x.payload = JSON.parse(plainret.resString); 
			} catch(e) {
				try {
					x.payload=JSON.parse(e.resString);
				} catch (ee) {
					x.state=e.statusCode;
					x.payload={};
					x.payload.string=e.resString;
					x.payload.status='bug';
				} finally {
					x.payload.status='bug';
				}
			}
			if (x.payload.status == 'created') {
				adobject.created=true;
				show_noti("QSO added: "+adobject.qsos[0].CALL);
			} else {
				adobject.created=false;
				console.log(x);
				adobject.fail=x;
				if (x.payload.messages) {
					adobject.fail.payload.reason=x.payload.messages.join();
				}
				show_noti("QSO NOT added: "+adobject.qsos[0].CALL);
			}
			toservicestatus({service:"udp", status:"received", msg: adobject});
		} else {
			toservicestatus({service:"udp", status:"warning", reason:"no ADIF detected. WSJT-X: Use ONLY Secondary UDP-Server"});
		}
	});
	WServer.bind(port);
});

function toservicestatus(msg) { 
    try {
        s_mainWindow.webContents.send('serviceStatus', msg);
    } catch (e) {
        msgbacklog.push(msg);
    }
}

function startserver() {
	try {
		httpServer = http.createServer(function (req, res) {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.writeHead(200, {'Content-Type': 'text/plain'});
			res.end('');
			const parts = req.url.substr(1).split('/');
			const qrg = parts[0];
			const mode = parts[1] || '';
			if (Number.isInteger(Number.parseInt(qrg))) {
				settrx(qrg,mode);
			}
		}).listen(54321);
		toservicestatus({service:"httpserver", status:"running", port:54321});

		startWebSocketServer();
	} catch(e) {
		toservicestatus({service:"httpserver", status:"blocked", reason:"Port 54321 in use"});
	}
}

function startWebSocketServer() {
	try {
		wsServer = new WebSocket.Server({ port: 54322, exclusive: true });
		toservicestatus({service:"websocketserver", status:"running", port:54322});
		wsServer.on('connection', (ws) => {
			wsClients.add(ws);
			console.log('WebSocket client connected');

			ws.on('close', () => {
				wsClients.delete(ws);
			});

			ws.on('error', (error) => {
				console.error('WebSocket error:', error);
				wsClients.delete(ws);

			});

			ws.send(JSON.stringify({
				type: 'welcome',
				message: 'Connected to WaveLogGate WebSocket server'
			}));
			broadcastRadioStatus(currentCAT);
		});

		wsServer.on('error', (error) => {
			console.error('WebSocket server error:', error);
			toservicestatus({service:"websocketserver", status:"error", reason:error.message});
		});

	} catch(e) {
		console.error('WebSocket server startup error:', e);
		toservicestatus({service:"websocketserver", status:"blocked", reason:"Port 54322 in use"});
	}
}

function broadcastRadioStatus(radioData) {
	currentCAT=radioData;
	let message = {
		type: 'radio_status',
		frequency: radioData.frequency ? parseInt(radioData.frequency) : null,
		mode: radioData.mode || null,
		power: radioData.power || null,
		radio: radioData.radio || 'wlstream',
		cat_url: radioData.cat_url || 'http://127.0.0.1:54321',
		timestamp: Date.now()
	};
	if (radioData.frequency_rx) {
		message.frequency_rx = parseInt(radioData.frequency_rx);
	}

	const messageStr = JSON.stringify(message);
	wsClients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(messageStr);
		}
	});
}

async function get_modes() {
	return new Promise((resolve) => {
		ipcMain.once('get_info_result', (event, modes) => {
			resolve(modes);
		});
		s_mainWindow.webContents.send('get_info', 'rig.get_modes');
	});
}

function getClosestMode(requestedMode, availableModes) {
	if (availableModes.includes(requestedMode)) {
		return requestedMode;
	}

	const modeFallbacks = {
		'CW': ['CW-L', 'CW-R', 'CW', 'LSB', 'USB'],
		'RTTY': ['RTTY', 'RTTY-R'],
	};

	if (modeFallbacks[requestedMode]) {
		for (let variant of modeFallbacks[requestedMode]) {
			if (availableModes.includes(variant)) {
				return variant;
			}
		}
	}

	const found = availableModes.find(mode =>
					  mode.toUpperCase().startsWith(requestedMode.toUpperCase())
					 );
					 if (found) return found;
					 return null;
}

async function settrx(qrg, mode = '') {
	let avail_modes={};
	try {
		avail_modes=await get_modes();
	} catch(e) {
		avail_modes=[];
	}
	let to={};
	to.qrg=qrg;
	if (mode == 'cw') {
		to.mode=getClosestMode(mode,avail_modes);
	} else {
		if ((to.qrg) < 7999000) {
			to.mode='LSB';
		} else {
			to.mode='USB';
		}
	}
	
	const client = net.createConnection({ host: '127.0.0.1', port: 4532 }, () => {
		client.write("F " + to.qrg + "\n");
		client.write("M " + to.mode + "\n-1");
		client.end();
	});

	activeConnections.add(client);

	client.on("error", (err) => {
		activeConnections.delete(client);
	});
	client.on("close", () => {
		activeConnections.delete(client);
	});

	return true;
}

function fmt(spotDate) {
	const retstr={};
	const d=spotDate.getUTCDate().toString();
	const y=spotDate.getUTCFullYear().toString();
	const m=(1+spotDate.getUTCMonth()).toString();
	const h=spotDate.getUTCHours().toString();
	const i=spotDate.getUTCMinutes().toString();
	const s=spotDate.getUTCSeconds().toString();
	retstr.d=y.padStart(4,'0')+m.padStart(2,'0')+d.padStart(2,'0');
	retstr.t=h.padStart(2,'0')+i.padStart(2,'0')+s.padStart(2,'0');
	return retstr;
}
