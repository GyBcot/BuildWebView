const HISTORY_KEY = 'w2a_history';
const MAX_HISTORY = 20;
const POLL_INTERVAL = 6000;
const PAGE_SIZE = 5;

let pollTimer = null;
let elapsedTimer = null;
let currentRunId = null;
let currentBuildMeta = null;
let iconMode = 'url';
let iconFile = null;
let iconUploadedUrl = null;
let historyPage = 1;
let confirmCallback = null;

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));

const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const saveHistory = (list) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY))); } catch {} };

const addToHistory = (entry) => {
    const list = loadHistory().filter(h => String(h.run_id) !== String(entry.run_id));
    list.unshift(entry);
    saveHistory(list);
    historyPage = 1;
    renderHistory();
};

const updateHistoryItem = (run_id, patch) => {
    const list = loadHistory().map(h => String(h.run_id) === String(run_id) ? { ...h, ...patch } : h);
    saveHistory(list);
    renderHistory();
};

const removeFromHistory = (run_id) => {
    saveHistory(loadHistory().filter(h => String(h.run_id) !== String(run_id)));
    renderHistory();
};

const fmtDate = (iso) => {
    if (!iso) return '';
    return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtDuration = (ms) => {
    if (!ms || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtElapsed = (startIso) => fmtDuration(Date.now() - new Date(startIso).getTime());
const fmtBytes = (bytes) => {
    bytes = parseInt(bytes) || 0;
    if (bytes <= 0) return '0 B';
    const u = ['B','KB','MB','GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
};

const downloadFile = (downloadUrl) => {
    window.location.href = downloadUrl;
};

const statusBadgeHtml = (status, conclusion) => {
    const resolved = conclusion || status;
    const map = {
        queued:      { cls:'badge-queued',    icon:'fa-clock',           label:'Antri',      pulse:false },
        in_progress: { cls:'badge-running',   icon:'fa-spinner fa-spin', label:'Building',   pulse:true  },
        success:     { cls:'badge-success',   icon:'fa-check',           label:'Selesai',    pulse:false },
        failure:     { cls:'badge-failure',   icon:'fa-xmark',           label:'Gagal',      pulse:false },
        cancelled:   { cls:'badge-cancelled', icon:'fa-ban',             label:'Dibatalkan', pulse:false },
    };
    const b = map[resolved] || map.queued;
    const dot = b.pulse ? '<span class="pulse-dot"></span>' : `<i class="fas ${b.icon}"></i>`;
    return `<span class="badge ${b.cls}">${dot} ${b.label}</span>`;
};

const BUILD_STEPS = [
    { label:'Checkout repo',    desc:'Mengambil source code' },
    { label:'Setup JDK & SDK',  desc:'Menyiapkan lingkungan Android' },
    { label:'Generate source',  desc:'Membuat file Java & resource' },
    { label:'Setup icon',       desc:'Memproses ikon aplikasi' },
    { label:'Compile & DEX',    desc:'Kompilasi Java ke bytecode' },
    { label:'Package & Sign',   desc:'Membungkus dan menandatangani APK' },
    { label:'Upload artifact',  desc:'Menyimpan APK hasil build' },
];

const getStepState = (idx, status, conclusion, createdAt) => {
    if (!status || status === 'queued') return 'pending';
    if (status === 'in_progress') {
        const elapsed = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 1000 : 0;
        const approx = Math.min(BUILD_STEPS.length - 1, Math.floor(elapsed / 25));
        if (idx < approx) return 'done';
        if (idx === approx) return 'active';
        return 'pending';
    }
    if (conclusion === 'success') return 'done';
    if (conclusion === 'failure') {
        const elapsed = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 1000 : 0;
        const approx = Math.min(BUILD_STEPS.length - 1, Math.floor(elapsed / 25));
        if (idx < approx) return 'done';
        if (idx === approx) return 'error';
        return 'pending';
    }
    return 'pending';
};

const renderStatusCard = (runData, buildMeta) => {
    const { run_id, status, conclusion, created_at } = runData;
    const iconMap = { done:'fa-check', active:'fa-spinner fa-spin', pending:'fa-circle', error:'fa-xmark' };
    const stepsHtml = BUILD_STEPS.map((step, i) => {
        const state = getStepState(i, status, conclusion, created_at);
        return `<div class="step">
            <div class="step-dot ${state}"><i class="fas ${iconMap[state]}"></i></div>
            <div class="step-info">
                <div class="step-name">${escHtml(step.label)}</div>
                <div class="step-desc">${escHtml(step.desc)}</div>
            </div>
        </div>`;
    }).join('');
    const isRunning = status === 'in_progress' || status === 'queued';
    return `<div class="card status-card">
        <div class="status-header">
            <span class="status-title">${escHtml(buildMeta?.app_name || 'Build APK')}</span>
            ${statusBadgeHtml(status, conclusion)}
        </div>
        <div class="build-steps">${stepsHtml}</div>
        ${isRunning ? `<div class="elapsed" id="elapsed-${run_id}">Berjalan...</div>` : ''}
    </div>`;
};

const renderResultCard = (runData, artifacts, buildMeta) => {
    const artifact = artifacts[0];
    const dlUrl = `/api/build/download/${artifact.id}`;
    const duration = runData.run_duration_ms ? fmtDuration(runData.run_duration_ms) : '';
    return `<div class="result-card">
        <div class="result-top">
            <div class="result-icon"><i class="fas fa-check-circle"></i></div>
            <div class="result-text">
                <h3>APK Siap Diunduh!</h3>
                <p>${escHtml(buildMeta?.app_name || 'Aplikasi')} · v${escHtml(buildMeta?.version_name || '1.0.0')}</p>
            </div>
        </div>
        <div class="result-meta">
            <div class="meta-row"><span class="meta-label">Nama file</span><span class="meta-value">${escHtml(artifact.name)}</span></div>
            <div class="meta-row"><span class="meta-label">Ukuran</span><span class="meta-value">${fmtBytes(artifact.size_in_bytes)}</span></div>
            ${duration ? `<div class="meta-row"><span class="meta-label">Durasi build</span><span class="meta-value">${duration}</span></div>` : ''}
            <div class="meta-row"><span class="meta-label">Selesai</span><span class="meta-value">${fmtDate(runData.updated_at)}</span></div>
        </div>
        <div class="result-actions">
            <button class="dl-btn" onclick="downloadFile('/api/build/download/${artifact.id}')">
                <i class="fas fa-download"></i> Unduh APK
            </button>
        </div>
    </div>`;
};

const renderFailedCard = (buildMeta) => `<div class="failed-card">
    <i class="fas fa-circle-xmark"></i>
    <h3>Build Gagal</h3>
    <p>Proses build untuk <strong>${escHtml(buildMeta?.app_name || 'aplikasi')}</strong> mengalami error. Periksa konfigurasi atau coba lagi.</p>
    <button class="retry-btn" id="retry-btn"><i class="fas fa-rotate-right"></i> Coba Lagi</button>
</div>`;

const showView = (name) => {
    $('view-form').style.display   = name === 'form'   ? 'block' : 'none';
    $('view-status').style.display = name === 'status' ? 'block' : 'none';
    $('view-result').style.display = name === 'result' ? 'block' : 'none';
};

const stopPolling = () => {
    if (pollTimer)    { clearInterval(pollTimer);    pollTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
};

const startElapsedTimer = (createdAt, runId) => {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
        const el = document.getElementById(`elapsed-${runId}`);
        if (el) el.textContent = `Berjalan ${fmtElapsed(createdAt)}`;
    }, 1000);
};

const startPolling = (run_id, buildMeta) => {
    stopPolling();
    currentRunId = run_id;
    currentBuildMeta = buildMeta;
    const doPoll = async () => {
        const res = await fetch(`/api/build/status/${run_id}`).then(r => r.json()).catch(() => null);
        if (!res?.success) return;
        const data = res.data;
        updateHistoryItem(run_id, { status: data.status, conclusion: data.conclusion, updated_at: data.updated_at, run_duration_ms: data.run_duration_ms });
        $('status-card-wrap').innerHTML = renderStatusCard(data, buildMeta);
        startElapsedTimer(data.created_at, run_id);
        if (data.status === 'completed') {
            stopPolling();
            if (data.conclusion === 'success') {
                const artRes = await fetch(`/api/build/artifacts/${run_id}`).then(r => r.json()).catch(() => null);
                if (artRes?.success && artRes.data?.length > 0) {
                    updateHistoryItem(run_id, { conclusion: 'success', artifact_id: artRes.data[0].id, artifact_name: artRes.data[0].name, artifact_size: artRes.data[0].size_in_bytes });
                    showResult(data, artRes.data, buildMeta);
                } else { showFailed(buildMeta); }
            } else {
                updateHistoryItem(run_id, { conclusion: data.conclusion || 'failure' });
                showFailed(buildMeta);
            }
        }
    };
    doPoll();
    pollTimer = setInterval(doPoll, POLL_INTERVAL);
};

const showResult = (runData, artifacts, buildMeta) => {
    $('result-wrap').innerHTML = renderResultCard(runData, artifacts, buildMeta);
    showView('result');
};

const showFailed = (buildMeta) => {
    $('result-wrap').innerHTML = renderFailedCard(buildMeta);
    showView('result');
    const retryBtn = $('retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => {
        showView('form');
        if (currentBuildMeta) restoreFormValues(currentBuildMeta);
    });
};

const restoreFormValues = (meta) => {
    if (!meta) return;
    ['app_name','package_name','website_url','tagline','version_name','version_code'].forEach(f => {
        const el = $(f); if (el && meta[f]) el.value = meta[f];
    });
    if (meta.splash_bg) {
        $('splash_bg_text').value = meta.splash_bg;
        const hex = '#' + meta.splash_bg;
        $('splash_bg_picker').value = hex;
        $('splash_bg_swatch').style.background = hex;
    }
    if (meta.primary_color) {
        $('primary_color_text').value = meta.primary_color;
        const hex = '#' + meta.primary_color;
        $('primary_color_picker').value = hex;
        $('primary_color_swatch').style.background = hex;
    }
    if (meta.icon_url && meta.icon_url.startsWith('http')) {
        $('icon_url').value = meta.icon_url;
    }
};

const renderHistory = () => {
    const all = loadHistory();
    const wrap = $('history-wrap');
    const clearBtn = $('clear-history-btn');
    if (!wrap) return;

    if (all.length === 0) {
        clearBtn && (clearBtn.style.display = 'none');
        wrap.innerHTML = `<div class="history-empty"><i class="fas fa-clock-rotate-left"></i><p>Belum ada riwayat build.</p></div>`;
        return;
    }

    clearBtn && (clearBtn.style.display = 'inline-flex');

    const totalPages = Math.ceil(all.length / PAGE_SIZE);
    if (historyPage > totalPages) historyPage = totalPages;
    if (historyPage < 1) historyPage = 1;

    const start = (historyPage - 1) * PAGE_SIZE;
    const end   = Math.min(start + PAGE_SIZE, all.length);
    const paged = all.slice(start, end);

    const items = paged.map(h => {
        const resolved = h.conclusion || h.status || 'queued';
        const dotClass = resolved === 'success' ? 'success' : resolved === 'failure' ? 'failure' : (resolved === 'in_progress' || resolved === 'queued') ? 'running' : 'queued';
        const isRunning = h.status === 'in_progress' || h.status === 'queued';
        const hasDl = h.conclusion === 'success' && h.artifact_id;
        const time = h.created_at ? fmtDate(h.created_at) : '';
        return `<div class="history-item" data-run="${h.run_id}">
            <div class="history-status-dot ${dotClass}"></div>
            <div class="history-body">
                <div class="history-name-row">
                    <span class="history-name">${escHtml(h.app_name || 'Build APK')}</span>
                    <span class="history-version">v${escHtml(h.version_name || '1.0.0')}</span>
                </div>
                <span class="history-pkg">${escHtml(h.package_name || '')}</span>
                ${time ? `<div class="history-time">${time}</div>` : ''}
            </div>
            <div class="history-actions">
                ${hasDl
                    ? `<button class="history-action" title="Unduh APK" data-dl="${h.artifact_id}"><i class="fas fa-download"></i></button>`
                    : isRunning
                    ? `<button class="history-action" title="Lihat status" data-view="${h.run_id}"><i class="fas fa-eye"></i></button>`
                    : ''
                }
                <button class="history-action danger" title="Hapus" data-delete="${h.run_id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>`;
    }).join('');

    const paginationHtml = totalPages > 1 ? `
        <div class="pagination">
            <div class="pagination-info">Menampilkan ${start + 1}–${end} dari ${all.length} build</div>
            <div class="pagination-controls">
                <button class="pagination-btn" id="page-prev" ${historyPage <= 1 ? 'disabled' : ''}>
                    <i class="fas fa-chevron-left"></i> Sebelumnya
                </button>
                <span class="pagination-page">${historyPage} / ${totalPages}</span>
                <button class="pagination-btn" id="page-next" ${historyPage >= totalPages ? 'disabled' : ''}>
                    Berikutnya <i class="fas fa-chevron-right"></i>
                </button>
            </div>
        </div>` : '';

    wrap.innerHTML = `<div class="history-list">${items}</div>${paginationHtml}`;

    const prevBtn = $('page-prev');
    const nextBtn = $('page-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { historyPage--; renderHistory(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { historyPage++; renderHistory(); });
};

const setupHistoryDelegation = () => {
    const wrap = $('history-wrap');
    if (!wrap) return;

    wrap.addEventListener('click', (e) => {
        const dlBtn = e.target.closest('[data-dl]');
        if (dlBtn) {
            e.stopPropagation();
            downloadFile(`/api/build/download/${dlBtn.dataset.dl}`);
            return;
        }

        const deleteBtn = e.target.closest('[data-delete]');
        if (deleteBtn) {
            e.stopPropagation();
            const run_id = deleteBtn.dataset.delete;
            showConfirm(
                'Hapus Riwayat?',
                'Riwayat build ini akan dihapus dari browser.',
                () => {
                    saveHistory(loadHistory().filter(h => String(h.run_id) !== String(run_id)));
                    const remaining = loadHistory();
                    const maxPage = Math.ceil(remaining.length / PAGE_SIZE) || 1;
                    if (historyPage > maxPage) historyPage = maxPage;
                    renderHistory();
                }
            );
            return;
        }

        const viewBtn = e.target.closest('[data-view]');
        if (viewBtn) {
            e.stopPropagation();
            const h = loadHistory().find(x => String(x.run_id) === String(viewBtn.dataset.view));
            if (!h) return;
            $('status-card-wrap').innerHTML = `<div class="loader-inline"><div class="spinner"></div> Memuat status...</div>`;
            showView('status');
            startPolling(h.run_id, h);
            return;
        }

        const item = e.target.closest('.history-item');
        if (item && !e.target.closest('a, button')) {
            const h = loadHistory().find(x => String(x.run_id) === String(item.dataset.run));
            if (!h) return;
            if (h.conclusion === 'success' && h.artifact_id) {
                downloadFile(`/api/build/download/${h.artifact_id}`);
            } else if (h.status === 'in_progress' || h.status === 'queued') {
                $('status-card-wrap').innerHTML = `<div class="loader-inline"><div class="spinner"></div> Memuat status...</div>`;
                showView('status');
                startPolling(h.run_id, h);
            }
        }
    });
};

const showConfirm = (title, msg, onOk) => {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = msg;
    confirmCallback = onOk;
    $('confirm-overlay').style.display = 'flex';
};

const closeConfirm = () => {
    $('confirm-overlay').style.display = 'none';
    confirmCallback = null;
};

window.closeConfirm = closeConfirm;

const confirmClearHistory = () => {
    showConfirm(
        'Hapus Semua Riwayat?',
        'Semua riwayat build akan dihapus dari browser ini. Tindakan ini tidak dapat dibatalkan.',
        () => {
            saveHistory([]);
            historyPage = 1;
            renderHistory();
        }
    );
};

window.confirmClearHistory = confirmClearHistory;

$('confirm-ok-btn').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
});

$('confirm-overlay').addEventListener('click', (e) => {
    if (e.target === $('confirm-overlay')) closeConfirm();
});

const setupColorPicker = (pickerId, swatchId, textId) => {
    const picker = $(pickerId), swatch = $(swatchId), text = $(textId);
    const sync = (hex) => {
        const clean = hex.replace('#','').toLowerCase();
        swatch.style.background = '#' + clean;
        picker.value = '#' + clean;
        if (document.activeElement !== text) text.value = clean;
    };
    picker.addEventListener('input', () => sync(picker.value));
    swatch.addEventListener('click', () => picker.click());
    text.addEventListener('input', () => {
        const val = text.value.replace(/[^0-9a-fA-F]/g,'').slice(0,6);
        text.value = val;
        if (val.length === 6) sync(val);
    });
    text.addEventListener('blur', () => {
        if (text.value.length < 6) {
            const defaults = { splash_bg_text:'0a1628', primary_color_text:'0d9488' };
            text.value = defaults[textId] || '000000';
            sync(text.value);
        }
    });
};

const setupIconTabs = () => {
    document.querySelectorAll('.icon-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.icon-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            iconMode = btn.dataset.tab;
            $('icon-panel-url').style.display    = iconMode === 'url'    ? 'block' : 'none';
            $('icon-panel-upload').style.display = iconMode === 'upload' ? 'block' : 'none';
            if (iconMode === 'url') { iconFile = null; iconUploadedUrl = null; }
        });
    });
    const zone = $('icon-upload-zone');
    const fileInput = $('icon-file-input');
    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) setIconFile(f); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) setIconFile(fileInput.files[0]); });
    $('icon-remove-btn').addEventListener('click', () => {
        iconFile = null; iconUploadedUrl = null; fileInput.value = '';
        $('icon-upload-zone').style.display  = 'flex';
        $('icon-preview-wrap').style.display = 'none';
        $('icon-upload-hint').textContent    = 'File akan diupload saat build dimulai.';
    });
};

const setIconFile = (file) => {
    const allowed = ['image/png','image/jpeg','image/jpg','image/webp'];
    if (!allowed.includes(file.type)) {
        $('icon-upload-hint').textContent = 'Format tidak didukung. Gunakan PNG/JPG/WEBP.';
        $('icon-upload-hint').classList.add('error'); return;
    }
    if (file.size > 5 * 1024 * 1024) {
        $('icon-upload-hint').textContent = 'File terlalu besar. Maksimal 5MB.';
        $('icon-upload-hint').classList.add('error'); return;
    }
    iconFile = file; iconUploadedUrl = null;
    $('icon-upload-hint').textContent = 'File akan diupload saat build dimulai.';
    $('icon-upload-hint').classList.remove('error');
    const reader = new FileReader();
    reader.onload = (e) => {
        $('icon-preview-img').src = e.target.result;
        $('icon-preview-name').textContent = file.name;
        $('icon-upload-zone').style.display  = 'none';
        $('icon-preview-wrap').style.display = 'flex';
    };
    reader.readAsDataURL(file);
};

const uploadIconIfNeeded = async () => {
    if (iconMode === 'url') return $('icon_url').value.trim();
    if (!iconFile) return '';
    if (iconUploadedUrl) return iconUploadedUrl;
    const formData = new FormData();
    formData.append('icon', iconFile);
    const res = await fetch('/api/build/upload-icon', { method:'POST', body:formData }).then(r => r.json()).catch(() => null);
    if (!res?.success) throw new Error(res?.message || 'Gagal mengupload icon.');
    iconUploadedUrl = res.data.url;
    return iconUploadedUrl;
};

const validateForm = () => {
    let valid = true;
    const setErr = (id, msg) => {
        const el = $(id); if (!el) return;
        el.classList.toggle('invalid', !!msg);
        const hint = el.closest('.form-field')?.querySelector('.form-hint');
        if (hint) { hint.textContent = msg || hint.dataset.orig || ''; hint.classList.toggle('error', !!msg); }
        if (msg) valid = false;
    };
    const app_name = $('app_name').value.trim();
    const pkg      = $('package_name').value.trim();
    const url      = $('website_url').value.trim();
    const ver_name = $('version_name').value.trim();
    const ver_code = $('version_code').value.trim();
    setErr('app_name',    !app_name  ? 'Nama aplikasi wajib diisi.' : '');
    const pkgOk = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,}$/.test(pkg);
    setErr('package_name', !pkg ? 'Package name wajib diisi.' : !pkgOk ? 'Format tidak valid. Contoh: com.nama.aplikasi' : '');
    setErr('website_url', !url ? 'URL website wajib diisi.' : !/^https?:\/\/.+/.test(url) ? 'Harus diawali http:// atau https://' : '');
    setErr('version_name', !ver_name ? 'Version name wajib diisi.' : '');
    setErr('version_code', !ver_code ? 'Version code wajib diisi.' : isNaN(parseInt(ver_code)) ? 'Harus berupa angka.' : '');
    return valid;
};

const handleSubmit = async () => {
    const errorBanner = $('form-error');
    errorBanner.classList.remove('show');
    if (!validateForm()) {
        errorBanner.textContent = 'Periksa kembali isian yang belum lengkap.';
        errorBanner.classList.add('show');
        errorBanner.scrollIntoView({ behavior:'smooth', block:'center' });
        return;
    }
    const btn = $('submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memulai build...';
    let icon_url = '';
    try {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengupload icon...';
        icon_url = await uploadIconIfNeeded();
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-hammer"></i> Build APK Sekarang';
        errorBanner.textContent = e.message;
        errorBanner.classList.add('show');
        return;
    }
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memulai build...';
    const buildMeta = {
        app_name:      $('app_name').value.trim(),
        package_name:  $('package_name').value.trim(),
        website_url:   $('website_url').value.trim(),
        tagline:       $('tagline').value.trim(),
        version_name:  $('version_name').value.trim(),
        version_code:  $('version_code').value.trim(),
        splash_bg:     $('splash_bg_text').value.trim(),
        primary_color: $('primary_color_text').value.trim(),
        icon_url,
    };
    const res = await fetch('/api/build/trigger', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(buildMeta),
    }).then(r => r.json()).catch(() => null);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-hammer"></i> Build APK Sekarang';
    if (!res?.success) {
        errorBanner.textContent = res?.message || 'Gagal memulai build. Coba lagi.';
        errorBanner.classList.add('show');
        return;
    }
    addToHistory({ ...buildMeta, run_id: res.data.run_id, status: res.data.status, conclusion: null, created_at: res.data.created_at, html_url: res.data.html_url });
    $('status-card-wrap').innerHTML = renderStatusCard(res.data, buildMeta);
    showView('status');
    startPolling(res.data.run_id, buildMeta);
};

document.addEventListener('DOMContentLoaded', () => {
    $('year').textContent = new Date().getFullYear();

    setupColorPicker('splash_bg_picker',     'splash_bg_swatch',     'splash_bg_text');
    setupColorPicker('primary_color_picker', 'primary_color_swatch', 'primary_color_text');
    setupIconTabs();
    setupHistoryDelegation();

    $('submit-btn').addEventListener('click', handleSubmit);
    $('cancel-btn').addEventListener('click', () => { stopPolling(); showView('form'); });
    $('new-build-btn').addEventListener('click', () => { stopPolling(); showView('form'); });

    ['app_name','package_name','website_url','version_name','version_code'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('input', () => el.classList.remove('invalid'));
    });

    renderHistory();

    const inProgress = loadHistory().find(h => h.status === 'in_progress' || h.status === 'queued');
    if (inProgress) {
        $('status-card-wrap').innerHTML = renderStatusCard(inProgress, inProgress);
        showView('status');
        startPolling(inProgress.run_id, inProgress);
    }
});