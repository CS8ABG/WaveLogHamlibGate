let cfg={};
let active_cfg=0;
let trxpoll=undefined;
let utcTimeInterval=undefined;
let activeConnections = new Set(); 
let activeAbortControllers = new Set();
let $ = require("jquery");


const { ipcRenderer } = require('electron/renderer');
const net = require('net');
let oldCat={ vfo: 0, mode: "SSB" };
let lastCat=0;
let hamlibFullList = [];

$(document).ready(async function() {
	cfg = ipcRenderer.sendSync("get_config");
	active_cfg = cfg.activeProfile ?? 0;
	applySystemTheme();
	updateStationsTable();
	renderProfileTabs();
	autoStartActiveProfile();
	hamlibButtonState();

	utcTimeInterval = setInterval(updateUtcTime, 1000);
	window.onload = updateUtcTime;

	$("#qso_log").hide();
	$("#error_log").hide();
	$("#open_settings").on("click", function () {
		$("#status").hide();
		$("#statsnavbar").hide();
		$("#status_card").hide();
		$("#download_hamlib").hide();
		$("#settings").show();
	});

	$("#back").on("click", function () {
		$("#status").show();
		$("#statsnavbar").show();
		$("#download_hamlib").show();
		$("#status_card").show();
		$("#settings").hide();
	});

	$('#mode_selector').click(function() {
        const html = $('html');
        const icon = $(this).find('i');

        if (html.attr('data-bs-theme') === 'dark') {
            html.attr('data-bs-theme', 'light');
            icon.removeClass('bi-moon-fill').addClass('bi-sun-fill'); 
        } else {
            html.attr('data-bs-theme', 'dark');
            icon.removeClass('bi-sun-fill').addClass('bi-moon-fill');
        }
    });

	$(document).on('change', '[id^=wavelog_key_]', function() {
		const index = parseInt(this.id.split('_').pop(), 10);
		getStations(index);
	});

	$(document).on('change', '[id^=wavelog_url_]', function() {
		const index = parseInt(this.id.split('_').pop(), 10);
		getStations(index);
	});
	
	ipcRenderer.on('get_info', async (event, arg) => {
		const result = await getInfo(arg);
		ipcRenderer.send('get_info_result', result);
	});

	ipcRenderer.on('cleanup', () => {
		cleanup();
	});

	$("#download_hamlib").on("click", async function () {
		$("#hamlib_status").text('downloading...');
		try {
			const r = await window.HAMLIB_API.stopHamlib();
			if (r.ok) {
				$('#hamlib_rigctld').removeClass('bg-success').addClass('bg-secondary').text('inactive');

				$(`#hamlib_start_${active_cfg}`).removeClass('btn-outline-success').addClass('btn-outline-primary').prop('disabled', false);
				$(`#hamlib_stop_${active_cfg}`).removeClass('btn-outline-primary').addClass('btn-outline-secondary').prop('disabled', true);
			} else {
				$('#hamlib_status').text(`stop failed: ${r.reason || 'unknown'}`);
			}
			const res = await window.HAMLIB_API.downloadHamlib();
			await refreshHamlibStatus();
			renderProfileTabs()
			$("#hamlib_status").text('installed');
		} catch (e) {
			console.error(e);
			$("#hamlib_status").text('download failed');
		}
	});
});

function applySystemTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const html = $('html');
    const modeBtn = $('#mode_selector');
    const icon = modeBtn.length ? modeBtn.find('i') : null;

    if (prefersDark) {
        html.attr('data-bs-theme', 'dark');

        if (icon) {
            icon.removeClass('bi-sun-fill').addClass('bi-moon-fill');
        }
    } else {
        html.attr('data-bs-theme', 'light');

        if (icon) {
            icon.removeClass('bi-moon-fill').addClass('bi-sun-fill');
        }
    }
}

function updateStationsTable() {
	refreshHamlibStatus();
	cfg = ipcRenderer.sendSync("get_config", active_cfg);
    const table = document.querySelector("#stations_table_body");
    if (!table) return;
	
    table.innerHTML = "";

	if (!cfg.profiles || cfg.profiles.length === 0) return;

    cfg.profiles.forEach((profile, index) => {
        const row = document.createElement("tr");

        const stationCell = document.createElement("td");
        stationCell.textContent = profile.wavelog_radioname || "(no name)";
        row.appendChild(stationCell);

        const freqCell = document.createElement("td");
        if (index === active_cfg) {
			freqCell.id = "current_trx"
        } else {
            freqCell.textContent = " ";
        }
        row.appendChild(freqCell);

        const statusCell = document.createElement("td");
		statusCell.classList.add("text-center");
        if (index === active_cfg) {
            statusCell.innerHTML = `<span class="badge rounded-pill text-bg-success">active</span>`;
        } else {
            statusCell.innerHTML = `<button class="btn btn-sm btn-outline-secondary py-0 px-2 activate-profile" data-p="${index}">Activate</button>`;
        }
        row.appendChild(statusCell);

        table.appendChild(row);
	
    });

    document.querySelectorAll(".activate-profile").forEach(btn => {
		btn.addEventListener("click", async (e) => {
			const p = Number(e.target.dataset.p);

			cleanup();

			try {
				const r = await window.HAMLIB_API.stopHamlib();
				if (r.ok) {
					$('#hamlib_status').text('stopped');
					$('#hamlib_rigctld').removeClass('bg-success').addClass('bg-secondary').text('inactive');

					hamlibButtonState();

				} else {
					$('#hamlib_status').text(`stop failed: ${r.reason || 'unknown'}`);
				}
			} catch (err) {
				$('#hamlib_status').text('stop failed: '+err);
			}

			active_cfg = p;

			cfg.activeProfile = active_cfg;
			ipcRenderer.sendSync("set_config", cfg);

			updateStationsTable();
			renderProfileTabs(); 
			autoStartActiveProfile();
		});
	});

}

function renderProfileTabs() {
    const tabList = $("#profileTabs");
    const tabContent = $("#profileTabsContent");

    tabList.empty();
    tabContent.empty();

    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {

        tabList.append(`
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="profile-tab-plus">+</button>
            </li>
        `);

        if (!Array.isArray(cfg.profiles)) cfg.profiles = [];

        $("#profile-tab-plus").off("click").on("click", () => {
            const newIndex = cfg.profiles.length;
            const defaultName = `Station ${newIndex + 1}`;
            const defaultProfile = {
                wavelog_url: "https://wavelog.server/index.php/",
                wavelog_key: "my-api-key",
                wavelog_radioname: defaultName,
				wavelog_cat_url: 'http://127.0.0.1:54321',
                trx_poll: 1000,
                hamlib_model: "",
                hamlib_com: "",
                hamlib_baud: 9600,
                hamlib_civ: "",
                hamlib_extptt: false,
                hamlib_ptt_com: "",
                hamlib_ptt_type: "RTS",
                hamlib_autostart: false,
                wavelog_id: ""
            };

            cfg.profiles.push(defaultProfile);
            ipcRenderer.send("set_config", cfg);

            renderProfileTabs();
            updateStationsTable();
        });

        // nothing else to do (no existing profiles)
        return;
    }

    cfg.profiles.forEach((profile, index) => {

        const tabId = `profile-tab-${index}`;
        const paneId = `profile-pane-${index}`;

        const isActive = index === active_cfg ? "active" : "";
        const expanded = index === active_cfg ? "show active" : "";

        tabList.append(`
            <li class="nav-item" role="presentation">
                <button class="nav-link ${isActive}" id="${tabId}" 
                    data-bs-toggle="tab" data-bs-target="#${paneId}"
                    type="button" role="tab">
                    ${profile.wavelog_radioname || `Profile ${index + 1}`}
                </button>
            </li>
        `);

        tabContent.append(`
            <div class="tab-pane fade ${expanded}" id="${paneId}" role="tabpanel">
				<div class="row mt-2">
					<div class="col-4">
						<label>Station Name</label>
						<input id="wavelog_radioname_${index}" type="text" class="form-control form-control-sm" maxlength="15" value="${profile.wavelog_radioname || ''}">
					</div>
					<div class="col-8 d-flex justify-content-end">
						<button class="btn btn-outline-success btn-sm mt-4" id="save_profile_${index}"> Save Station </button>&nbsp;&nbsp;&nbsp;
						<button class="btn btn-outline-danger btn-sm mt-4 delete-profile-btn" data-p="${index}">Delete Station</button>
					</div>
				</div>
				<div  class="card mt-3">
					<div class="card-header text-center">
						<strong>Wavelog Settings</strong>
					</div>
					<div class="card-body">
						<div class="row">
							<div class="col">
								<label>URL</label>
								<input id="wavelog_url_${index}" type="text" class="form-control form-control-sm mb-2" value="${profile.wavelog_url || ''}">
							</div>
							<div class="col">
								<label>API Key</label>
								<input id="wavelog_key_${index}" type="text" class="form-control form-control-sm mb-2" value="${profile.wavelog_key || ''}">
							</div>
						</div>
						<div class="row">
							<div class="col-8">
								<label>Station ID</label>
								<select id="wavelog_id_${index}" class="form-control form-control-sm" disabled>
									<option value="${profile.wavelog_id || ''}">No stations loaded</option>
								</select>
							</div>
							<div class="col">
								<button id="wavelog_refresh_${index}" class="btn btn-sm btn-outline-secondary mt-4">
										<svg id="reload_icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="14" height="14" fill="currentColor" class="mb-1">
										<path d="M463.5 224l8.5 0c13.3 0 24-10.7 24-24l0-128c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8l119.5 0z"/>
									</svg>
								</button>&nbsp;&nbsp;&nbsp;
								<button id="test_${index}" class="btn btn-sm btn-outline-primary mt-4">Test</button>
							</div>
						</div>
						<div class="row">
							<div class="col-6">
								<div class="col">
									<label>CAT URL</label>
									<input id="wavelog_cat_url_${index}" type="text" class="form-control form-control-sm mb-2" value="${profile.wavelog_cat_url || 'http://127.0.0.1:54321'}">
								</div>
							</div>
						</div>
					</div>
				</div>
				<div  class="card mt-2">
					<div class="card-header text-center">
						<strong>Radio Settings</strong>
					</div>
					<div class="card-body">
						<div class="row">
							<div class="col">
								<label>Manufacturer</label>
								<select id="hamlib_mfg_${index}" class="form-select form-select-sm mb-2"></select>
							</div>
							<div class="col">
								<label>Model</label>
								<select id="hamlib_model_${index}" class="form-select form-select-sm mb-2"></select>
							</div>
							<div class="col-2">
								<label>CI-V</label>
								<input id="hamlib_civ_${index}" type="text" class="form-control form-control-sm mb-2">
							</div>
						</div>
						<div class="row">
							<div class="col">
								<label>CAT Port</label>
								<select id="hamlib_com_${index}" class="form-select form-select-sm mb-2"></select>
							</div>
							<div class="col">
								<label>Baudrate</label>
								<select id="hamlib_baud_${index}" class="form-control form-control-sm mb-2">
									<option value="300">300</option>
									<option value="600">600</option>
									<option value="1200">1200</option>
									<option value="2400">2400</option>
									<option value="4800">4800</option>
									<option value="9600">9600</option>
									<option value="19200">19200</option>
									<option value="38400">38400</option>
									<option value="57600">57600</option>
									<option value="115200">115200</option>
								</select>
							</div>
							<div class="col-4">
								<label id="trxpoll_label_${index}">Poll (in ms)</label>
								<input id="trx_poll_${index}" type="number" class="form-control form-control-sm mb-2" value="${profile.trx_poll || '1000'}">
							</div>
						</div>
						<div class="row">
							<div class="col">
								<div class="form-check mb-2">
									<input class="form-check-input" type="checkbox"	id="hamlib_extptt_${index}">
									<label class="form-check-label">Use External PTT</label>
								</div>
							</div>
						</div>
						<div class="row">
							<div class="col-4">
								<label>PTT COM Port</label>
								<select id="hamlib_ptt_com_${index}" class="form-select form-select-sm mb-2"></select>
							</div>
							<div class="col-4">
								<label>PTT Type</label>
								<select id="hamlib_ptt_type_${index}" class="form-select form-select-sm mb-2">
									<option value="RTS">RTS</option>
									<option value="DTR">DTR</option>
								</select>
							</div>
						</div>
						<div class="row mb-3">
							<div class="col">
								<div class="form-check mt-2">
									<input class="form-check-input" type="checkbox" id="hamlib_autostart_${index}">
									<label class="form-check-label">Auto-Start Hamlib</label>
								</div>
							</div>
							<div class="col text-end">
								<span id="radio_status_${index}" class="text-muted"></span>
							</div>
						</div>
						<div class="row">
							<div class="col-4">
								<button id="hamlib_start_${index}" class="btn btn-outline-secondary btn-sm" disabled>Start Hamlib</button>
							</div>
							<div class="col-4">
								<button id="hamlib_stop_${index}" class="btn btn-outline-secondary btn-sm" disabled>Stop Hamlib</button>
							</div>
						</div>
					</div>
				</div>
            </div>
        `);

		$(`#hamlib_start_${index}`).on("click", async () => {
			const idx = index;

			const hamlibMfg = $(`#hamlib_mfg_${idx}`).val().trim();
			const modelId = $(`#hamlib_model_${idx}`).val().trim();
			const comPath = $(`#hamlib_com_${idx}`).val().trim();
			const baud = $(`#hamlib_baud_${idx}`).val().trim();
			const civ = $(`#hamlib_civ_${idx}`).val().trim();
			const extPTT = $(`#hamlib_extptt_${idx}`).is(':checked');
			const pttFile = $(`#hamlib_ptt_com_${idx}`).val().trim();
			const pttType = $(`#hamlib_ptt_type_${idx}`).val().trim();

			if (!modelId) {
				$('#hamlib_status').text('select model');
				return;
			}
			if (!comPath) {
				$('#hamlib_status').text('select COM');
				return;
			}

			const opts = {
				model: Number(modelId),
				rigFile: comPath,
				baud,
				civ: (hamlibMfg.toLowerCase() === 'icom' && civ) ? civ : undefined,
				pttFile: extPTT ? pttFile : undefined,
		    	pttType: extPTT ? pttType : undefined
			};

			$('#hamlib_status').text('starting rigctld...');
			const r = await window.HAMLIB_API.startRigctld(opts);

			if (r.ok) {
				$('#hamlib_status').text(`running (pid ${r.pid})`);
				$('#hamlib_rigctld').removeClass('bg-secondary').addClass('bg-success').text('running');

			} else {
				$('hamlib_status').text(`start failed: ${r.reason || 'unknown'}`);
			}
			hamlibButtonState();
		});

		$(`#hamlib_stop_${index}`).on("click", async () => {
			const r = await window.HAMLIB_API.stopHamlib();

			if (r.ok) {
				$('#current_trx').html('');
				$(`#radio_status_${active_cfg}`).text('');
				$('#hamlib_status').text('');
				$('#hamlib_rigctld').removeClass('bg-success').addClass('bg-secondary').text('inactive');
			} else {
				$('hamlib_status').text(`stop failed: ${r.reason || 'unknown'}`);
			}
			hamlibButtonState();
		});

		$(`#save_profile_${index}`).off('click').on('click', () => {
			const idx = index;

			const profile = cfg.profiles[idx];
			profile.wavelog_radioname = $(`#wavelog_radioname_${idx}`).val().trim();
			profile.wavelog_url = $(`#wavelog_url_${idx}`).val().trim();
			profile.wavelog_key = $(`#wavelog_key_${idx}`).val().trim();
			profile.wavelog_id = $(`#wavelog_id_${idx}`).val();
			profile.wavelog_cat_url = $(`#wavelog_cat_url_${idx}`).val().trim();
			profile.trx_poll = parseInt($(`#trx_poll_${idx}`).val(), 10) || 1000;

			profile.hamlib_mfg = $(`#hamlib_mfg_${idx}`).val();
			profile.hamlib_model = $(`#hamlib_model_${idx}`).val();
			profile.hamlib_com = $(`#hamlib_com_${idx}`).val();
			profile.hamlib_baud = $(`#hamlib_baud_${idx}`).val();
			profile.hamlib_civ = $(`#hamlib_civ_${idx}`).val();
			profile.hamlib_extptt = $(`#hamlib_extptt_${idx}`).is(':checked');
			profile.hamlib_ptt_com = $(`#hamlib_ptt_com_${idx}`).val();
			profile.hamlib_ptt_type = $(`#hamlib_ptt_type_${idx}`).val();
			profile.hamlib_autostart = $(`#hamlib_autostart_${idx}`).is(':checked');

			ipcRenderer.sendSync("set_config", cfg);
			alert(`"${profile.wavelog_radioname || idx}" saved successfully.`);

			renderProfileTabs();
			updateStationsTable();

		});

		$(`#wavelog_refresh_${index}`).on("click", () => {
			getStations(index);
		});

		$(`#test_${index}`).on("click", () => {
			const idx = index;

			cfg.profiles[idx].wavelog_url       = $(`#wavelog_url_${idx}`).val().trim();
			cfg.profiles[idx].wavelog_key       = $(`#wavelog_key_${idx}`).val().trim();
			cfg.profiles[idx].wavelog_id        = $(`#wavelog_id_${idx}`).val();
			cfg.profiles[idx].wavelog_cat_url   = $(`#wavelog_cat_url_${idx}`).val().trim();
			cfg.profiles[idx].wavelog_radioname = $(`#wavelog_radioname_${idx}`).val().trim();

			const result = ipcRenderer.sendSync("test", cfg.profiles[idx]);
			const testBtn = $(`#test_${idx}`);

			if (result.payload.status === 'created') {
				testBtn.removeClass('btn-outline-danger').addClass('btn-outline-success');
			} else {
				testBtn.removeClass('btn-outline-success').addClass('btn-outline-danger');
			}
		});

    });

	updateRadioFields();
	hamlibButtonState();

    tabList.append(`
        <li class="nav-item" role="presentation">
            <button class="nav-link" id="profile-tab-plus">+</button>
        </li>
    `);

	$("#profile-tab-plus").on("click", () => {
		if (!cfg.profiles) cfg.profiles = [];

		const newIndex = cfg.profiles.length;
		const defaultName = `Station ${newIndex + 1}`;

		const defaultProfile = {
			wavelog_url: "https://wavelog.server/index.php/",
			wavelog_key: "my-api-key",
			wavelog_radioname: defaultName,
			wavelog_cat_url: "http://127.0.0.1:54321",
			trx_poll: 1000,
			hamlib_model: "",
			hamlib_com: "",
			hamlib_baud: 9600,
			hamlib_civ: "",
			hamlib_extptt: false,
			hamlib_ptt_com: "",
			hamlib_ptt_type: "RTS",
			hamlib_autostart: false,
			wavelog_id: ""
		};

		cfg.profiles.push(defaultProfile);

		ipcRenderer.send("set_config", cfg);

		renderProfileTabs();
		updateStationsTable();

	});

	$(".delete-profile-btn").off("click").on("click", function () {
		const index = Number($(this).data("p"));

		if (index === active_cfg) {
			alert("You cannot delete the active Station. Please activate another station first.");
			return;
		}

		if (!confirm(`Are you sure you want to delete "${cfg.profiles[index].wavelog_radioname || index}"?`)) {
			return;
		}

		cfg.profiles.splice(index, 1);

		ipcRenderer.sendSync("set_config", cfg);

		renderProfileTabs();
		updateStationsTable();
	});

	const idx = active_cfg;
    if (cfg.profiles[idx].wavelog_key && cfg.profiles[idx].wavelog_url) {
        getStations(idx);
    }
}

function updateRadioFields() {

    if (!cfg || !cfg.profiles) return;

    cfg.profiles.forEach((profile, idx) => {

        const extEnabled = profile.hamlib_extptt || false;

        $(`#hamlib_model_${idx}`).val(profile.hamlib_model || "");
        $(`#hamlib_com_${idx}`).val(profile.hamlib_com || "");
        $(`#hamlib_baud_${idx}`).val(profile.hamlib_baud || "9600");
        $(`#hamlib_civ_${idx}`).val(profile.hamlib_civ || "");
        $(`#hamlib_extptt_${idx}`).prop("checked", extEnabled);
        $(`#hamlib_ptt_com_${idx}`).val(profile.hamlib_ptt_com || "").prop("disabled", !extEnabled);
        $(`#hamlib_ptt_type_${idx}`).val(profile.hamlib_ptt_type || "RTS").prop("disabled", !extEnabled);
        $(`#hamlib_autostart_${idx}`).prop("checked", profile.hamlib_autostart || false);
        $(`#hamlib_extptt_${idx}`).off('change').on('change', function () {
            const enabled = $(this).is(':checked');
            profile.hamlib_extptt = enabled;
            $(`#hamlib_ptt_com_${idx}`).prop("disabled", !enabled);
            $(`#hamlib_ptt_type_${idx}`).prop("disabled", !enabled);
        });

        refreshHamlibModels(idx);

        $(`#hamlib_mfg_${idx}`).off('change').on('change', function () {
            const selectedMfg = $(this).val();
            const models = hamlibFullList.filter(x => x.mfg === selectedMfg);

            const hamlibModel = $(`#hamlib_model_${idx}`);
            hamlibModel.empty();
            hamlibModel.append(new Option("Select model…", ""));

            models.forEach(m => hamlibModel.append(new Option(m.model, m.id)));

            hamlibModel.val("");

            // CI-V field only enabled for Icom
            $(`#hamlib_civ_${idx}`)[0].disabled = selectedMfg.toLowerCase() !== "icom";
        });

        refreshSerialPorts(idx);
    }); 
}

function hamlibButtonState() {
    cfg.profiles.forEach((p, index) => {
        const startBtn = $(`#hamlib_start_${index}`);
        const stopBtn  = $(`#hamlib_stop_${index}`);
		const rigStatus = $(`#hamlib_rigctld`).text().trim();

        if (!startBtn.length || !stopBtn.length) return;

        if (active_cfg === index) {
			if (rigStatus === 'running') {
				// active and running
				startBtn.prop('disabled', true)
						.removeClass('btn-outline-secondary')
						.addClass('btn-outline-success');

				stopBtn.prop('disabled', false)
					   .removeClass('btn-outline-secondary')
					   .addClass('btn-outline-primary');
			} else {
				// active but not running
				startBtn.prop('disabled', false)
						.removeClass('btn-outline-secondary')
						.addClass('btn-outline-primary');

				stopBtn.prop('disabled', true)
					   .removeClass('btn-outline-secondary')
					   .addClass('btn-outline-secondary');
			}
        } else {
			// inactive station
            startBtn.prop('disabled', true)
                    .removeClass('btn-outline-secondary')
                    .addClass('btn-outline-secondary');

            stopBtn.prop('disabled', true)
                   .removeClass('btn-outline-primary')
                   .addClass('btn-outline-secondary');
        }
    });
}


function autoStartActiveProfile() {
    const index = active_cfg;

    try {
        const autostart = $(`#hamlib_autostart_${index}`).is(':checked');
        const rigStatus = $(`#hamlib_rigctld`).text().trim();
        if (autostart && rigStatus !== 'running') {
            const hamlibStartBtn = $(`#hamlib_start_${index}`);

            setTimeout(() => {
                hamlibStartBtn.click();
            }, 1000);
        }
    } catch (e) {
        console.warn("Hamlib autostart skipped:", e);
    }

    try {
        if (cfg.profiles[index]) {
            if (trxpoll === undefined) {
                getsettrx();
            }
        }
    } catch (e) {
        console.warn("TRX auto polling skipped:", e);
    }
}

function addAlert(message, level = 'error', timeout = 5000) {
	let alertClass;
	switch(level.toLowerCase()) {
		case 'error':
			alertClass = 'alert-danger';
			break;
		case 'warning':
			alertClass = 'alert-warning';
			break;
		case 'success':
			alertClass = 'alert-success';
			break;
		case 'info':
		default:
			alertClass = 'alert-info';
			break;
	}

	$("#error_log").fadeIn();

	const alertHtml = $(`
		<div class="alert ${alertClass} alert-dismissible fade show" role="alert">
			<strong>${level.charAt(0).toUpperCase() + level.slice(1)}: </strong> ${message}
			<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
		</div>
	`);

	$("#error_log").html(alertHtml);

	setTimeout(function() {
		$("#error_log").hide();
	}, timeout);
}

function addQso(item) {
	const msg = item.msg;
	const qso = msg.qsos?.[0];
	const row = $('<tr></tr>');

	let timeFormatted = '';
	if (qso.TIME_ON) {
		const timeStr = qso.TIME_ON.toString().padStart(6, '0');
		const hh = timeStr.slice(0, 2);
		const mm = timeStr.slice(2, 4);
		const ss = timeStr.slice(4, 6);
		timeFormatted = `${hh}:${mm}:${ss}z`;
	}

	const reasonText = msg.created ? '' : (msg.fail?.payload?.reason || 'Unknown');

	row.append('<td>' + (timeFormatted || '') + '</td>');
	row.append('<td>' + (qso.CALL || '') + '</td>');
	row.append('<td>' + (qso.GRIDSQUARE || 'No Grid') + '</td>');
	row.append('<td>' + (qso.BAND || 'No BAND') + '</td>');
	row.append('<td>' + (qso.RST_RCVD || 'No RST') + '</td>');
	row.append('<td>' + (qso.RST_SENT || 'No RST') + '</td>');

	if (msg.created) {
		row.append('<td class="text-success">OK</td>');
	} else {
		row.append('<td class="text-danger">Error</td>');
		addAlert(reasonText, 'error');
	}

	const tbody = $("#log_table_body");
	tbody.append(row);

	const qsoLog = $("#qso_log");
	if (!qsoLog.is(':visible')) {
		qsoLog.show();
	}

	const container = tbody.parent().parent();
	container.scrollTop(container[0].scrollHeight);
}

window.TX_API.onServiceStatus((value) => {
	const items = Array.isArray(value) ? value : [value];
    items.forEach((item) => {
        switch (item.service) {
            case 'udp':
                if (item.status === 'running') {
                    $("#udp_status").removeClass('bg-secondary').addClass('bg-success').text('running');
                    $("#udp_status_port").append(item.port);
                } else if (item.status === 'blocked') {
                    $("#udp_status").removeClass('bg-secondary').addClass('bg-danger').text('blocked');
					addAlert(item.reason, 'warning');
                } else if (item.status === 'error') {
					addAlert(item.reason, 'error');
				} else if (item.status === 'warning') {
					addAlert(item.reason, 'warning');
				}else if (item.status === 'received') {
					addQso(item);
				}
                break;

            case 'httpserver':
                if (item.status === 'running') {
                    $("#http_status").removeClass('bg-secondary').addClass('bg-success').text('running');
                    $("#http_status_port").append(item.port);
                } else if (item.status === 'blocked') {
                    $("#http_status").removeClass('bg-secondary').addClass('bg-danger').text('blocked');
					addAlert(item.reason, 'warning');
                } else if (item.status === 'error') {
					addAlert(item.reason, 'error');
				} else if (item.status === 'warning') {
					addAlert(item.reason, 'warning');
				}
                break;

            case 'websocketserver':
                if (item.status === 'running') {
                    $("#ws_status").removeClass('bg-secondary').addClass('bg-success').text('running');
                    $("#ws_status_port").append(item.port);
                } else if (item.status === 'blocked') {
                    $("#ws_status").removeClass('bg-secondary').addClass('bg-danger').text('blocked');
					addAlert(item.reason, 'warning');
                }else if (item.status === 'error') {
					addAlert(item.reason, 'error');
				} else if (item.status === 'warning') {
					addAlert(item.reason, 'warning');
				}
                break;
        }
    });
});

async function get_trx() {
	let currentCat={};
	const formatFreq = num => num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

	currentCat.vfo=await getInfo('rig.get_vfo');
	currentCat.mode=await getInfo('rig.get_mode');
	currentCat.ptt=await getInfo('rig.get_ptt');
	currentCat.power=await getInfo('rig.get_power');
	currentCat.split=await getInfo('rig.get_split');
	currentCat.vfoB=await getInfo('rig.get_vfoB');
	currentCat.modeB=await getInfo('rig.get_modeB');

	let txpower = Math.trunc(currentCat.power * 100);
	let vfoA = formatFreq(currentCat.vfo);
	let vfoB = formatFreq(currentCat.vfoB);

	let txstatus2='<span style="display:inline-block;width:10px;height:10px;background:green;border-radius:50%;margin-left:5px;"></span>';
	let txstatus='<span class="badge text-bg-success">RX</span>';
	if (currentCat.ptt == 1) {
		txstatus='<span class="badge text-bg-danger">TX</span>';
		txstatus2='<span style="display:inline-block;width:10px;height:10px;background:red;border-radius:50%;margin-left:5px;"></span>';
	}
	if (currentCat.split == 1) {
		$("#current_trx").html("TX: " + vfoB + " Hz | RX:" + vfoA + " Hz / " + currentCat.mode +" "+txstatus);
		$(`#radio_status_${active_cfg}`).html(txstatus2 + " " + vfoA + " Hz / " + currentCat.mode + " | Split: ON");
	} else {
		$("#current_trx").html("TX/RX: " + vfoA + " Hz / " + currentCat.mode + " - " + txpower + "W  " + txstatus);
		$(`#radio_status_${active_cfg}`).html(txstatus2 + " " + vfoA + " Hz / " + currentCat.mode);
	}
	//if (((Date.now()-lastCat) > (30*60*1000)) || (!(isDeepEqual(oldCat,currentCat)))) {
	if (((Date.now()-lastCat) > (30*1000)) || (!(isDeepEqual(oldCat,currentCat)))) {
		console.log(await informWavelog(currentCat));
	}

	oldCat=currentCat;
	return currentCat;
}

const isDeepEqual = (object1, object2) => {

	const objKeys1 = Object.keys(object1);
	const objKeys2 = Object.keys(object2);

	if (objKeys1.length !== objKeys2.length) return false;

	for (const key of objKeys1) {
		const value1 = object1[key];
		const value2 = object2[key];

		const isObjects = isObject(value1) && isObject(value2);

		if ((isObjects && !isDeepEqual(value1, value2)) ||
			(!isObjects && value1 !== value2)
		) {
			return false;
		}
	}
	return true;
};

const isObject = (object) => {
	return object != null && typeof object === "object";
};

async function getInfo(which) {
	const idx = active_cfg;
	var commands = {"rig.get_vfo": "f", "rig.get_mode": "m", "rig.get_ptt": "t", "rig.get_power": "l RFPOWER", "rig.get_split": "s", "rig.get_vfoB": "i", "rig.get_modeB": "m"};

	const host = "127.0.0.1";
	const port = 4532;

	return new Promise((resolve, reject) => {
		if (commands[which]) {
			const client = net.createConnection({ host, port }, () => client.write(commands[which] + "\n"));

			activeConnections.add(client);

			client.on('data', (data) => {
				data = data.toString()
				if(data.startsWith("RPRT")){
					reject();
				} else {
					resolve(data.split('\n')[0]);
				}
				client.end();
			});
			client.on('error', (err) => {
				activeConnections.delete(client);
				reject();
			});
			client.on("close", () => {
				activeConnections.delete(client);
			});
		} else {
			resolve(undefined);
		}
	});
}

async function getsettrx() {
	if (!cfg.profiles[active_cfg]) return;

	console.log('Polling TRX '+trxpoll);
	const x=get_trx();

	const interval = cfg.profiles[active_cfg].trx_poll || 1000;
	trxpoll = setTimeout(() => {
		getsettrx();
	}, interval);
}

async function informWavelog(CAT) {
	lastCat=Date.now();
	let data = {
		radio: cfg.profiles[active_cfg].wavelog_radioname || "Station",
		key: cfg.profiles[active_cfg].wavelog_key,
		cat_url: cfg.profiles[active_cfg].wavelog_cat_url,
	};
	if (CAT.power !== undefined && CAT.power !== 0) {
		data.power = CAT.power;
	}

	if (CAT.split == '1') {
		data.frequency=CAT.vfoB;
		data.mode=CAT.modeB;
		data.frequency_rx=CAT.vfo;
		data.mode_rx=CAT.mode;
	} else {
		data.frequency=CAT.vfo;
		data.mode=CAT.mode;
	}

	console.log(data);
	ipcRenderer.send('radio_status_update', data);

	let x=await fetch(cfg.profiles[active_cfg].wavelog_url + '/api/radio', {
		method: 'POST',
		rejectUnauthorized: false,
		headers: {
			Accept: 'application.json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(data)
	});
	return x;
}

function cleanupConnections() {
	console.log('Cleaning up renderer TCP connections...');

	activeConnections.forEach(connection => {
		try {
			if (connection && !connection.destroyed) {
				connection.destroy();
				console.log('Closed renderer TCP connection');
			}
		} catch (error) {
			console.error('Error closing renderer TCP connection:', error);
		}
	});

	activeConnections.clear();
	console.log('All renderer TCP connections cleaned up');

	activeAbortControllers.forEach(controller => {
		try {
			controller.abort();
			console.log('Aborted HTTP request');
		} catch (error) {
			console.error('Error aborting HTTP request:', error);
		}
	});

	activeAbortControllers.clear();
	console.log('All HTTP requests aborted');
}

function cleanup() {
	if (trxpoll) {
		clearTimeout(trxpoll);
		trxpoll = undefined;
		console.log('Cleared radio polling timeout');
	}

	if (utcTimeInterval) {
		clearInterval(utcTimeInterval);
		utcTimeInterval = undefined;
		console.log('Cleared UTC time update interval');
	}

	cleanupConnections();
}

function updateUtcTime() {
	const now = new Date();
	const hours = ('0' + now.getUTCHours()).slice(-2);
	const minutes = ('0' + now.getUTCMinutes()).slice(-2);
	const seconds = ('0' + now.getUTCSeconds()).slice(-2);
	const formattedTime = `${hours}:${minutes}:${seconds}z`;
	document.getElementById('utc').innerHTML = formattedTime;
}

async function getStations(index) {
    const url = document.getElementById(`wavelog_url_${index}`).value.trim();
    const key = document.getElementById(`wavelog_key_${index}`).value.trim();
    const select = document.getElementById(`wavelog_id_${index}`);

    select.innerHTML = "";
    select.disabled = true;

    if (!url || !key) {
        console.log("Missing Wavelog URL or API key");
        select.append(new Option("Missing URL or API key", "0"));
        return;
    }

    const fullUrl = `${url.replace(/\/+$/, '')}/api/station_info/${key}`;

    try {
        const response = await fetch(fullUrl, {
            method: "GET",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();


        select.innerHTML = "";
        if (data.length === 0) {
            select.append(new Option("No stations found", "0"));
        } else {
            data.forEach(st => {
                const label = `${st.station_profile_name} (${st.station_callsign}, ID: ${st.station_id})`;
                select.append(new Option(label, st.station_id));
            });

            const saved = cfg.profiles[index].wavelog_id;
            if (saved && data.some(d => d.station_id == saved)) {
                select.value = saved;
            } else {
                select.value = data[0].station_id;
            }
        }

        select.disabled = false;

    } catch (err) {
        console.error("Failed to load Wavelog stations:", err);
        select.innerHTML = "";
        select.append(new Option("Failed to load stations", "0"));
        select.disabled = false;
    }
}

async function refreshHamlibStatus() {
	try {
		const v = await window.HAMLIB_API.getHamlibVersion();
		if (v.installed) {
			$("#hamlib_version").text('Hamlib ' + (v.version || 'unknown'));
		} else {
			$("#hamlib_version").text('Not installed');
		}
	} catch (e) {
		$("#hamlib_version").text('Error');
	}
}

async function refreshHamlibModels(idx) {

    const hamlibMfg   = $(`#hamlib_mfg_${idx}`)[0];
    const hamlibModel = $(`#hamlib_model_${idx}`)[0];
    const hamlibCiv   = $(`#hamlib_civ_${idx}`)[0];

    try {
        const res = await window.HAMLIB_API.getRigList();
        hamlibFullList = res.ok ? res.list : [];

        hamlibMfg.innerHTML = "";
        hamlibModel.innerHTML = "";

        if (!res.ok || hamlibFullList.length === 0) {
            hamlibMfg.append(new Option("No hamlib models", ""));
            hamlibModel.append(new Option("No hamlib models", ""));
            return;
        }

        const mfgs = [...new Set(hamlibFullList.map(x => x.mfg))].sort();
        hamlibMfg.append(new Option("Select manufacturer…", ""));
        mfgs.forEach(m => hamlibMfg.append(new Option(m, m)));

        const saved = cfg.profiles[idx].hamlib_model;
        if (!saved) return;

        const entry = hamlibFullList.find(x => x.id == saved);
        if (!entry) return;

        hamlibMfg.value = entry.mfg;

        const models = hamlibFullList.filter(x => x.mfg === entry.mfg);
        hamlibModel.append(new Option("Select model…", ""));
        models.forEach(m => hamlibModel.append(new Option(m.model, m.id)));

        hamlibModel.value = saved;

        hamlibCiv.disabled = entry.mfg.toLowerCase() !== "icom";

    } catch (e) {
        hamlibMfg.innerHTML = "";
        hamlibMfg.append(new Option("Error loading hamlib models", ""));
    }
}

async function refreshSerialPorts(idx) {
    const hamlibCom    = $(`#hamlib_com_${idx}`)[0];
    const hamlibPttCom = $(`#hamlib_ptt_com_${idx}`)[0];
    hamlibCom.innerHTML = "";
    hamlibPttCom.innerHTML = "";

    try {
        const ports = await window.HAMLIB_API.getSerialPorts();
        const selCom = cfg.profiles[idx].hamlib_com || "";
        const selPtt = cfg.profiles[idx].hamlib_ptt_com || "";

        if (!ports || ports.length === 0) {
            hamlibCom.append(new Option("No serial ports", ""));
            hamlibPttCom.append(new Option("No serial ports", ""));
            return;
        }

        ports.forEach(p => {
            const opt1 = new Option(p.path, p.path);
            if (p.path === selCom) opt1.selected = true;
            hamlibCom.append(opt1);

            const opt2 = new Option(p.path, p.path);
            if (p.path === selPtt) opt2.selected = true;
            hamlibPttCom.append(opt2);
        });

    } catch (e) {
        hamlibCom.append(new Option("Error listing ports", ""));
        hamlibPttCom.append(new Option("Error listing ports", ""));
    }
}
