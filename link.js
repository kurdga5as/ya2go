// ya2go по ссылке: скачивание публичной папки Яндекс.Диска прямо в браузере.
//
// Папку человек выбирает один раз (File System Access API), дальше файлы
// ложатся туда сами, с подпапками, без окна «Сохранить» на каждый файл.
// Файлы идут из Яндекса прямо в браузер и на диск: сайт их не видит.
// Логика как в программе: по одному файлу, битые откладываются и пробуются
// ещё раз в конце, каждый файл сверяется по MD5, уже скачанное пропускается.
(function () {
    'use strict';

    const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
    const ROOT_NAME = 'Из Яндекс.Диска';
    const WORKERS = 4;
    // Сколько ждать байтов, прежде чем отложить файл: первый проход строже,
    // второй терпеливее. Целый файл по ссылке начинает идти за 4–8 секунд.
    const PASSES = [15000, 30000];

    const $ = (sel) => document.querySelector(sel);
    const ui = {
        unsupported: $('[data-unsupported]'),
        form: $('[data-link-form]'),
        input: $('#link'),
        linkStatus: $('[data-link-status]'),
        pick: $('[data-pick]'),
        folderStatus: $('[data-folder-status]'),
        start: $('[data-start]'),
        stop: $('[data-stop]'),
        progress: $('[data-progress]'),
        pct: $('[data-pct]'),
        bar: $('[data-bar]'),
        runStatus: $('[data-run-status]'),
        runCurrent: $('[data-run-current]'),
        report: $('[data-report]'),
    };

    const state = {key: '', name: '', single: null, files: [], total: 0, dir: null, running: false, stop: null};

    // ?opfs — тестовый режим без системного окна выбора папки (см. обработчик «Выбрать папку»).
    const testMode = new URLSearchParams(location.search).has('opfs') && !!(navigator.storage && navigator.storage.getDirectory);
    const supported = 'showDirectoryPicker' in window || testMode;
    if (!supported) {
        ui.unsupported.hidden = false;
    }

    // ---------- форматирование ----------

    const GB = 1024 ** 3;
    function size(b) {
        if (b >= 1024 * GB) return fmt(b / (1024 * GB), 1) + ' ТБ';
        if (b >= GB) return fmt(b / GB, b < 10 * GB ? 1 : 0) + ' ГБ';
        if (b >= 1048576) return fmt(b / 1048576, 0) + ' МБ';
        return fmt(Math.max(b / 1024, 1), 0) + ' КБ';
    }
    function fmt(n, d) { return n.toLocaleString('ru-RU', {maximumFractionDigits: d}); }
    function plural(n, one, few, many) {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    }
    const files = (n) => fmt(n, 0) + ' ' + plural(n, 'файл', 'файла', 'файлов');
    function duration(sec) {
        if (!isFinite(sec) || sec <= 0) return '';
        const h = Math.round(sec / 3600);
        if (h >= 1) return 'около ' + h + ' ' + plural(h, 'часа', 'часов', 'часов');
        const m = Math.max(1, Math.round(sec / 60));
        return 'около ' + m + ' ' + plural(m, 'минуты', 'минут', 'минут');
    }
    function esc(t) {
        return String(t).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
    }
    // Имена с Яндекса могут содержать символы, запрещённые в Windows.
    function safeName(name) {
        const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
        return s || '_';
    }

    // ---------- шаг 1: ссылка ----------

    async function api(params) {
        const url = API + '?' + new URLSearchParams(params);
        const r = await fetch(url);
        if (r.status === 404) throw new Error('notfound');
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
    }

    async function walk(path, out) {
        for (let offset = 0; ; ) {
            const p = {public_key: state.key, limit: 1000, offset};
            if (path) p.path = path;
            const d = await api(p);
            const items = (d._embedded && d._embedded.items) || [];
            for (const it of items) {
                if (it.type === 'dir') await walk(it.path, out);
                else out.push({path: it.path, size: it.size || 0, md5: it.md5 || ''});
            }
            offset += items.length;
            ui.linkStatus.textContent = 'Считаем файлы… ' + files(out.length);
            if (!items.length || offset >= d._embedded.total) return out;
        }
    }

    ui.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (state.running) return;
        const key = ui.input.value.trim();
        if (!/^https:\/\/(disk\.yandex\.(ru|com|kz|by|com\.tr)|yadi\.sk)\//i.test(key)) {
            ui.linkStatus.innerHTML = '<span class="bad">Это не похоже на ссылку Яндекс.Диска. Нужна ссылка вида https://disk.yandex.ru/d/…</span>';
            return;
        }
        state.key = key;
        state.files = [];
        ui.linkStatus.textContent = 'Проверяем ссылку…';
        setReady();
        try {
            const meta = await api({public_key: key, limit: 0});
            state.name = meta.name || 'Папка';
            if (meta.type === 'file') {
                state.single = {path: '', size: meta.size || 0, md5: meta.md5 || '', name: meta.name};
                state.files = [state.single];
            } else {
                state.single = null;
                state.files = await walk('', []);
            }
            state.total = state.files.reduce((s, f) => s + f.size, 0);
            ui.linkStatus.innerHTML = '<span class="ok">«' + esc(state.name) + '»: ' + files(state.files.length) + ', ' + size(state.total) + '</span>';
        } catch (err) {
            state.files = [];
            ui.linkStatus.innerHTML = '<span class="bad">' + (String(err.message) === 'notfound'
                ? 'По этой ссылке ничего не нашлось: возможно, её закрыли или в ней опечатка.'
                : 'Не получилось открыть ссылку. Проверьте интернет и попробуйте снова.') + '</span>';
        }
        setReady();
    });

    // ---------- шаг 2: папка ----------

    ui.pick.addEventListener('click', async () => {
        try {
            // ?opfs — проверка без системного окна: скрытое хранилище браузера
            // с тем же интерфейсом, что у настоящей папки.
            state.dir = testMode
                ? await navigator.storage.getDirectory()
                : await window.showDirectoryPicker({id: 'ya2go', mode: 'readwrite', startIn: 'documents'});
            ui.folderStatus.innerHTML = '<span class="ok">Папка «' + esc(state.dir.name) + '». Внутри будет «' + ROOT_NAME + '/' + esc(safeName(state.name)) + '».</span>';
        } catch (err) {
            if (err && err.name === 'AbortError') return; // человек закрыл окно
            ui.folderStatus.innerHTML = '<span class="bad">Браузер не дал доступ к этой папке. Выберите другую, например в «Документах» или на внешнем диске.</span>';
        }
        setReady();
    });

    function setReady() {
        ui.pick.disabled = !supported || !state.files.length || state.running;
        ui.start.disabled = !supported || !state.files.length || !state.dir || state.running;
    }

    // ---------- шаг 3: перенос ----------

    const dirCache = new Map();
    async function dirFor(root, parts) {
        let d = root, key = root === state.dir ? 'base:' : 'copy:';
        for (const part of parts) {
            key += '/' + part;
            if (!dirCache.has(key)) dirCache.set(key, d.getDirectoryHandle(part, {create: true}));
            d = await dirCache.get(key);
        }
        return d;
    }

    function partsOf(file) {
        const raw = file.path ? file.path.replace(/^\/+/, '').split('/') : [file.name];
        return raw.map(safeName);
    }

    // Уже скачанный файл того же размера пропускаем: так работает докачка между запусками.
    async function exists(dir, name, sz) {
        try {
            const f = await (await dir.getFileHandle(name)).getFile();
            return f.size === sz;
        } catch (e) {
            return false;
        }
    }

    async function downloadOne(file, root, idle, stats) {
        const parts = partsOf(file);
        const name = parts.pop();
        const dir = await dirFor(root, parts);
        if (await exists(dir, name, file.size)) {
            stats.skipped++;
            stats.bytes += file.size;
            return 'skip';
        }
        const p = {public_key: state.key};
        if (file.path) p.path = file.path;
        const r = await fetch(API + '/download?' + new URLSearchParams(p));
        if (!r.ok) throw new Error('href ' + r.status);
        const {href} = await r.json();

        const ctrl = new AbortController();
        state.stop.signal.addEventListener('abort', () => ctrl.abort(), {once: true});
        let timer = setTimeout(() => ctrl.abort(), idle);
        const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), idle); };

        let writable = null, got = 0;
        try {
            // Без Referer: с ним сервер скачивания Яндекса отвечает 403
            // (защита от встраивания файлов на чужие сайты).
            const resp = await fetch(href, {signal: ctrl.signal, referrerPolicy: 'no-referrer'});
            if (!resp.ok) {
                if (resp.status === 403 || resp.status === 429) stats.limited++;
                throw new Error('file ' + resp.status);
            }
            bump();
            const handle = await dir.getFileHandle(name, {create: true});
            // Браузер пишет во временный файл и подменяет им настоящий только при
            // close(): недокачанный файл в папке не появится.
            writable = await handle.createWritable();
            const md5 = new SparkMD5.ArrayBuffer();
            const reader = resp.body.getReader();
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                bump();
                await writable.write(value);
                md5.append(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
                got += value.byteLength;
                stats.bytes += value.byteLength;
                stats.inflight.set(file, got);
            }
            clearTimeout(timer);
            if (file.md5 && md5.end() !== file.md5) throw new Error('md5');
            await writable.close();
            writable = null;
            stats.done++;
            return 'ok';
        } catch (err) {
            clearTimeout(timer);
            stats.bytes -= got; // недокачанное не считаем
            if (writable) { try { await writable.abort(); } catch (e) { /* уже закрыт */ } }
            throw err;
        } finally {
            stats.inflight.delete(file);
        }
    }

    async function runPass(list, idle, stats) {
        const failed = [];
        let i = 0;
        async function worker() {
            while (i < list.length && !state.stop.signal.aborted) {
                const f = list[i++];
                stats.current.add(f);
                try {
                    await downloadOne(f, stats.root, idle, stats);
                } catch (err) {
                    if (state.stop.signal.aborted) return;
                    failed.push(f);
                } finally {
                    stats.current.delete(f);
                }
            }
        }
        await Promise.all(Array.from({length: WORKERS}, worker));
        return failed;
    }

    let wakeLock = null;
    async function keepAwake() {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    }
    document.addEventListener('visibilitychange', () => {
        if (state.running && document.visibilityState === 'visible') keepAwake();
    });
    window.addEventListener('beforeunload', (e) => {
        if (state.running) { e.preventDefault(); e.returnValue = ''; }
    });

    ui.start.addEventListener('click', async () => {
        if (state.running) return;
        // Разрешение на запись могли отозвать с прошлого раза.
        if (state.dir.requestPermission && (await state.dir.requestPermission({mode: 'readwrite'})) !== 'granted') {
            ui.folderStatus.innerHTML = '<span class="bad">Нужно разрешить сохранять файлы в эту папку.</span>';
            return;
        }
        state.running = true;
        state.stop = new AbortController();
        setReady();
        ui.start.hidden = true;
        ui.stop.hidden = false;
        ui.progress.hidden = false;
        ui.report.hidden = true;
        await keepAwake();

        dirCache.clear();
        const root = await dirFor(state.dir, [ROOT_NAME, safeName(state.name)]);
        const stats = {root, bytes: 0, done: 0, skipped: 0, limited: 0, current: new Set(), inflight: new Map(), started: Date.now(), pass: 1};
        const tick = setInterval(() => draw(stats), 1000);

        let left = state.files.slice();
        for (let p = 0; p < PASSES.length && left.length && !state.stop.signal.aborted; p++) {
            stats.pass = p + 1;
            left = await runPass(left, PASSES[p], stats);
        }
        clearInterval(tick);
        draw(stats);
        state.running = false;
        if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
        ui.start.hidden = false;
        ui.stop.hidden = true;
        ui.start.firstChild.textContent = 'Запустить ещё раз ';
        setReady();
        report(stats, left, state.stop.signal.aborted);
    });

    ui.stop.addEventListener('click', () => state.stop && state.stop.abort());

    function draw(stats) {
        const pct = state.total ? Math.min(100, Math.floor(stats.bytes / state.total * 100)) : 100;
        ui.pct.textContent = pct;
        ui.bar.style.width = pct + '%';
        ui.bar.parentElement.setAttribute('aria-valuenow', pct);
        const secs = (Date.now() - stats.started) / 1000;
        const speed = stats.bytes / Math.max(secs, 1);
        const eta = speed > 0 ? duration((state.total - stats.bytes) / speed) : '';
        ui.runStatus.textContent = size(stats.bytes) + ' из ' + size(state.total) + ' · готово ' + files(stats.done + stats.skipped) + ' из ' + fmt(state.files.length, 0)
            + (eta && stats.pass === 1 ? ' · осталось ' + eta : '');
        const names = Array.from(stats.current).map((f) => partsOf(f).pop());
        ui.runCurrent.textContent = stats.pass > 1
            ? 'Пробуем ещё раз файлы, которые Яндекс не отдал: ' + names.join(', ')
            : (names.length ? 'Сейчас: ' + names.join(', ') : '');
    }

    function report(stats, failed, stopped) {
        const failedNames = failed.map((f) => f.path || f.name);
        let html = '';
        if (stopped) {
            html += '<p class="tool-lead">Перенос остановлен.</p><p>Всё, что успели скачать, уже в папке. Нажмите «Запустить ещё раз», и перенос продолжится: скачанные файлы пропустятся.</p>';
        } else {
            html += '<p class="tool-lead ok">Готово</p><p>Скачано и сверено ' + files(stats.done + stats.skipped) + ' в папку «' + ROOT_NAME + '/' + esc(safeName(state.name)) + '».'
                + (stats.skipped ? ' Из них ' + fmt(stats.skipped, 0) + ' уже были в папке.' : '') + '</p>';
        }
        if (failedNames.length && !stopped) {
            html += '<p class="bad">' + files(failedNames.length) + ' Яндекс не отдал: на диске они повреждены или недоступны. Часто это временно: запустите ещё раз завтра.</p>'
                + '<ul class="tool-failed">' + failedNames.slice(0, 8).map((n) => '<li>' + esc(n) + '</li>').join('') + (failedNames.length > 8 ? '<li>…и ещё ' + fmt(failedNames.length - 8, 0) + '</li>' : '') + '</ul>'
                + '<button class="btn line-ink sm" type="button" data-save-list>Сохранить список</button>';
        }
        if (stats.limited > 3) {
            html += '<p class="bad">Яндекс ограничил скачивание по этой ссылке. Так бывает, если по ней качают слишком много за день. Попробуйте завтра или <a href="./#install">скачайте программу</a>: она работает через вход в аккаунт.</p>';
        }
        if (!stopped) {
            html += '<div class="tool-note"><b>Не забудьте закрыть ссылку.</b> На Яндекс.Диске: «Поделиться» у этой папки → выключите доступ по ссылке. Пока ссылка открыта, по ней может скачать любой, у кого она есть.</div>'
                + '<p class="muted">ya2go бесплатный. <a href="./#thanks">Поблагодарить автора</a></p>';
        }
        ui.report.innerHTML = html;
        ui.report.hidden = false;
        const save = ui.report.querySelector('[data-save-list]');
        if (save) save.addEventListener('click', () => {
            const blob = new Blob(['Эти файлы не удалось скачать по ссылке ' + state.key + '\n\n' + failedNames.join('\n') + '\n'], {type: 'text/plain;charset=utf-8'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Не скачались.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
    }

    setReady();
})();
