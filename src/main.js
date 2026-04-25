import './style.css';

// Firefox 检测：为 html 添加标识类，供 CSS 针对性处理原生控件差异
if (typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)) {
    document.documentElement.classList.add('is-firefox');
}

const API_URL = 'https://open.er-api.com/v6/latest/CNY';
// 汇率本地缓存时长（小时）。免费 API 一般每天更新一次，12h 足够。
const RATE_CACHE_HOURS = 12;
// 用户手动刷新汇率次数上限（每 RATE_CACHE_HOURS 内）。防止误触刷爆免费 API 配额。
const MANUAL_REFRESH_LIMIT = 2;
let htmlToImageModulePromise = null;

const currencySymbols = {
    'USD': '$', 'EUR': '\u20AC', 'GBP': '\u00A3', 'JPY': '\u00A5',
    'CNY': '\u00A5', 'HKD': 'HK$', 'AUD': 'A$', 'SGD': 'S$',
    'KRW': '\u20A9', 'TWD': 'NT$', 'CAD': 'C$'
};

const els = {
    price: document.getElementById('price'),
    currency: document.getElementById('currency'),
    cycles: document.getElementsByName('cycle'),
    dueDate: document.getElementById('dueDate'),
    tradeDate: document.getElementById('tradeDate'),
    customRate: document.getElementById('customRate'),
    apiRateDisplay: document.getElementById('apiRateDisplay'),
    refreshBtn: document.getElementById('refreshRateBtn'),
    refreshIcon: document.getElementById('refreshIcon'),
    symbolDisplay: document.querySelector('.symbol-display'),
    finalValue: document.getElementById('finalValue'),
    originalCurrencyValue: document.getElementById('originalCurrencyValue'),
    daysRemaining: document.getElementById('daysRemaining'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    priceCNYPreview: document.getElementById('priceCNYPreview'),
    toast: document.getElementById('toast'),
    rateLimitTip: document.getElementById('rateLimitTip'),
    themeToggle: document.getElementById('themeToggle'),
    themeToggleKnob: document.getElementById('themeToggleKnob')
};

let rateLimitTimer = null;

window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    loadInputsFromCookie(); 
    initDates(); 
    syncDateDisplay(els.dueDate);
    syncDateDisplay(els.tradeDate);
    initRates(); 
    setupEventListeners();
    calculate(); 
});

function setupEventListeners() {
    const debouncedSave = debounce(saveInputsToCookie, 500);

    [els.price, els.dueDate, els.tradeDate, els.customRate].forEach(el => el.addEventListener('input', () => {
        if (el.type === 'date') syncDateDisplay(el);
        calculate();
        debouncedSave();
    }));

    [els.dueDate, els.tradeDate].forEach(el => el.addEventListener('change', () => {
        syncDateDisplay(el);
        calculate();
        saveInputsToCookie();
    }));
    
    els.cycles.forEach(radio => radio.addEventListener('change', () => {
        calculate();
        saveInputsToCookie();
    }));

    els.currency.addEventListener('change', () => {
        updateCurrencySymbol();
        initRates(); 
        calculate();
        saveInputsToCookie();
    });

    els.refreshBtn.addEventListener('click', manualRefreshRate); 
    els.themeToggle.addEventListener('click', toggleTheme);

    // Firefox：date input 改为 visibility:hidden，不接收点击 → 在 wrapper 上绑定点击来触发 showPicker()
    // 非 Firefox：原生透明日历指示器在 webkit 上会自己响应点击，同时下面的 icon handler 作为后备
    if (document.documentElement.classList.contains('is-firefox')) {
        document.querySelectorAll('.date-input-wrapper').forEach((wrapper) => {
            wrapper.addEventListener('click', () => {
                const input = wrapper.querySelector('input[type="date"]');
                if (!input) return;
                try {
                    if (typeof input.showPicker === 'function') {
                        input.showPicker();
                    } else {
                        input.focus();
                    }
                } catch (err) {
                    // ignore
                }
            });
        });
    } else {
        // 非 Firefox：点击右侧自定义日历图标触发 picker
        document.querySelectorAll('.date-input-wrapper .date-input-icon').forEach((icon) => {
            icon.addEventListener('click', (e) => {
                const input = icon.parentElement && icon.parentElement.querySelector('input[type="date"]');
                if (!input) return;
                e.preventDefault();
                try {
                    if (typeof input.showPicker === 'function') {
                        input.showPicker();
                    } else {
                        input.focus();
                    }
                } catch (err) {
                    input.focus();
                }
            });
        });
    }

    // 价格 / 汇率 输入校验：负数或非法时高亮红边
    [els.price, els.customRate].forEach(el => {
        el.addEventListener('input', () => validateNumberInput(el));
        validateNumberInput(el);
    });

    // ESC 关闭模态 / 限流提示
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!modal.el.classList.contains('hidden')) closeImageModal();
        if (els.rateLimitTip.classList.contains('show')) hideRateLimitTip();
    });
}

function validateNumberInput(el) {
    const raw = el.value.trim();
    if (raw === '') {
        el.classList.remove('input-invalid');
        return true;
    }
    const v = parseFloat(raw);
    const ok = Number.isFinite(v) && v >= 0;
    el.classList.toggle('input-invalid', !ok);
    return ok;
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function initTheme() {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        updateToggleUI(true);
    } else {
        document.documentElement.classList.remove('dark');
        updateToggleUI(false);
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.theme = isDark ? 'dark' : 'light';
    updateToggleUI(isDark);
}

function updateToggleUI(isDark) {
    if (isDark) {
        els.themeToggleKnob.classList.add('translate-x-6');
        els.themeToggleKnob.classList.remove('translate-x-1');
    } else {
        els.themeToggleKnob.classList.remove('translate-x-6');
        els.themeToggleKnob.classList.add('translate-x-1');
    }
}

// 注意：函数名沿用历史命名（setCookie / getCookie），实际底层是 localStorage + 过期时间，
// 同时兼容旧版本可能写到 document.cookie 的数据。
function setCookie(name, value, hours) {
    const expiresAt = Date.now() + (hours * 60 * 60 * 1000);
    localStorage.setItem(name, JSON.stringify({ value, expiresAt }));
}

function getCookie(name) {
    const stored = localStorage.getItem(name);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (!parsed.expiresAt || parsed.expiresAt > Date.now()) {
                return parsed.value || "";
            }
            localStorage.removeItem(name);
        } catch (e) {
            localStorage.removeItem(name);
        }
    }

    const cname = name + "=";
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(';');
    for(let i = 0; i <ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(cname) == 0) {
            return c.substring(cname.length, c.length);
        }
    }
    return "";
}

async function getHtmlToImage() {
    if (!htmlToImageModulePromise) {
        htmlToImageModulePromise = import('html-to-image');
    }

    return htmlToImageModulePromise;
}

function formatDateForDisplay(value) {
    return value ? value.replace(/-/g, '/') : '--/--/--';
}

function syncDateDisplay(input) {
    const wrapper = input && input.parentElement;
    const display = wrapper && wrapper.querySelector('.date-display-value');
    if (!display) return;
    display.textContent = formatDateForDisplay(input.value);
}

function prepareDateInputsForExport(node) {
    const restoreTasks = [];
    const inputs = node.querySelectorAll('input[type="date"]');

    inputs.forEach((input) => {
        const wrapper = input.parentElement;
        if (!wrapper) return;
        const display = wrapper.querySelector('.date-display-value') || document.createElement('span');
        const hadDisplay = wrapper.contains(display);
        if (!hadDisplay) {
            display.className = 'date-display-value text-xs md:text-sm font-mono font-medium';
            wrapper.insertBefore(display, input.nextSibling);
        }
        display.classList.add('date-display-export');
        display.textContent = formatDateForDisplay(input.value);
        // visibility:hidden 而非 display:none：保留 input 在文档流中的占位高度，
        // 避免 wrapper 塌陷导致 position:absolute 的 display 层变为 0px 高度。
        input.style.visibility = 'hidden';

        restoreTasks.push(() => {
            input.style.visibility = '';
            display.classList.remove('date-display-export');
            if (!hadDisplay) display.remove();
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

/*
 * html-to-image 序列化时无法可靠保留 -webkit-/-moz-appearance 这类伪元素相关样式，
 * Firefox 截图里 number input 会重新出现上下调节按钮。导出前用 div 替换，导出后还原。
 */
function prepareNumberInputsForExport(node) {
    const restoreTasks = [];
    const inputs = node.querySelectorAll('input[type="number"]');

    inputs.forEach((input) => {
        const display = document.createElement('div');
        display.className = input.className;
        const cs = window.getComputedStyle(input);
        // 保留输入框的对齐方式（部分 number 框是居中显示的）
        display.style.display = 'flex';
        display.style.alignItems = 'center';
        display.style.justifyContent = cs.textAlign === 'center'
            ? 'center'
            : (cs.textAlign === 'right' ? 'flex-end' : 'flex-start');
        // 保留动态计算的左内边距，防止多字符货币符号（如 NT$）在截图时与数值重叠
        display.style.paddingLeft = cs.paddingLeft;
        display.textContent = input.value || input.placeholder || '';
        input.style.display = 'none';
        input.parentElement && input.parentElement.insertBefore(display, input);

        restoreTasks.push(() => {
            input.style.display = '';
            display.remove();
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

function prepareSelectInputsForExport(node) {
    const restoreTasks = [];
    const selects = node.querySelectorAll('select');

    selects.forEach((select) => {
        const optionSnapshots = Array.from(select.options).map((option) => ({
            defaultSelected: option.defaultSelected,
            hasSelectedAttr: option.hasAttribute('selected')
        }));

        Array.from(select.options).forEach((option) => {
            const isCurrent = option.value === select.value;
            option.defaultSelected = isCurrent;
            option.toggleAttribute('selected', isCurrent);
        });

        restoreTasks.push(() => {
            Array.from(select.options).forEach((option, index) => {
                const snapshot = optionSnapshots[index];
                option.defaultSelected = snapshot.defaultSelected;
                option.toggleAttribute('selected', snapshot.hasSelectedAttr);
            });
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

function saveInputsToCookie() {
    const data = {
        price: els.price.value,
        currency: els.currency.value,
        cycle: Array.from(els.cycles).find(r => r.checked)?.value || "365",
        dueDate: els.dueDate.value,
        customRate: els.customRate.value
    };
    setCookie("vps_inputs", JSON.stringify(data), 0.5);
}

function loadInputsFromCookie() {
    const saved = getCookie("vps_inputs");
    if (saved) {
        try {
            const data = JSON.parse(saved);
            if(data.price) els.price.value = data.price;
            if(data.currency) els.currency.value = data.currency;
            if(data.dueDate) els.dueDate.value = data.dueDate;
            if(data.customRate) els.customRate.value = data.customRate;
            if(data.cycle) {
                const radio = document.querySelector(`input[name="cycle"][value="${data.cycle}"]`);
                if(radio) radio.checked = true;
            }
            updateCurrencySymbol();
        } catch(e) { console.error("Cookie parse error", e); }
    }
}

async function initRates() {
    const base = els.currency.value;
    if (base === 'CNY') {
        finishRateUpdate(1, "1.0000");
        return;
    }

    const cacheKey = `vps_rate_${base}`;
    const cachedData = getCookie(cacheKey);

    if (cachedData) {
        try {
            const data = JSON.parse(cachedData);
            finishRateUpdate(data.rate, data.rate.toFixed(4));
        } catch (e) {
            manualRefreshRate(false);
        }
    } else {
        manualRefreshRate(false);
    }
}

async function manualRefreshRate(isUserClick = true) {
    const base = els.currency.value;
    if (base === 'CNY') return;

    const limitKey = "vps_refresh_limit";
    const rawLimit = getCookie(limitKey);
    let limitData = { count: 0, resetTime: Date.now() + 12*3600*1000 };

    if (rawLimit) {
        try {
            const parsed = JSON.parse(rawLimit);
            if (parsed.resetTime && Date.now() < parsed.resetTime) {
                limitData = parsed;
            } else {
                limitData = { count: 0, resetTime: Date.now() + RATE_CACHE_HOURS*3600*1000 };
            }
        } catch(e) {}
    }

    if (isUserClick) {
        if (limitData.count >= MANUAL_REFRESH_LIMIT) {
            showRateLimitTip();
            return;
        }
        limitData.count++;
        const hoursLeft = (limitData.resetTime - Date.now()) / (1000*3600);
        setCookie(limitKey, JSON.stringify(limitData), Math.max(0.1, hoursLeft));
    }

    await fetchExchangeRate();
}

async function fetchExchangeRate() {
    const base = els.currency.value;
    els.refreshIcon.classList.add('spin');
    els.apiRateDisplay.textContent = "刷新中";

    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        
        if (data.result === "success") {
            const baseInCNY = data.rates && data.rates[base];
            if (typeof baseInCNY === 'number' && baseInCNY > 0 && Number.isFinite(baseInCNY)) {
                const rate = 1 / baseInCNY;
                finishRateUpdate(rate, rate.toFixed(4));
                
                const cacheData = JSON.stringify({ rate: rate, time: Date.now() });
                setCookie(`vps_rate_${base}`, cacheData, RATE_CACHE_HOURS);
                saveInputsToCookie();
            } else {
                throw new Error("Invalid rate value");
            }
        } else {
            throw new Error("API Error");
        }
    } catch (error) {
        console.error(error);
        els.apiRateDisplay.textContent = "汇率刷新";
        els.refreshIcon.classList.remove('spin');
        showToast("获取汇率失败");
    }
}

function finishRateUpdate(rate, text) {
    els.customRate.value = rate.toFixed(4);
    els.apiRateDisplay.textContent = "汇率刷新";
    els.refreshIcon.classList.remove('spin');
    calculate();
}

function showRateLimitTip() {
    els.rateLimitTip.classList.add('show');
    if (rateLimitTimer) clearTimeout(rateLimitTimer);
    rateLimitTimer = setTimeout(() => {
        hideRateLimitTip();
    }, 2000);
}

function hideRateLimitTip() {
    els.rateLimitTip.classList.remove('show');
    if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
    }
}

function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    setTimeout(() => {
        els.toast.classList.remove('show');
    }, 2000);
}

function initDates() {
    const now = new Date();
    els.tradeDate.value = formatDate(now);
    syncDateDisplay(els.tradeDate);
    if (els.dueDate.value) {
        syncDateDisplay(els.dueDate);
        return;
    }
    const currentYear = now.getFullYear();
    const thisYearNov25 = new Date(currentYear, 10, 25); 
    let targetDueDate;
    if (now.getTime() <= thisYearNov25.getTime()) {
        targetDueDate = thisYearNov25;
    } else {
        targetDueDate = new Date(currentYear + 1, 10, 25);
    }
    els.dueDate.value = formatDate(targetDueDate);
    syncDateDisplay(els.dueDate);
}

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function updateCurrencySymbol() {
    const code = els.currency.value;
    const sym = currencySymbols[code] || code;
    els.symbolDisplay.textContent = sym;
    // Dynamically adjust input left padding to prevent symbol/text overlap
    requestAnimationFrame(() => {
        const symRect = els.symbolDisplay.getBoundingClientRect();
        const inputRect = els.price.getBoundingClientRect();
        const neededPad = symRect.right - inputRect.left + 6;
        els.price.style.paddingLeft = Math.max(neededPad, 32) + 'px';
    });
}

function calculate() {
    const priceRaw = parseFloat(els.price.value);
    const rateRaw = parseFloat(els.customRate.value);
    const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;
    const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 0;
    const due = new Date(els.dueDate.value);
    const trade = new Date(els.tradeDate.value);

    let cycleDays = 365;
    for (const radio of els.cycles) {
        if (radio.checked) { cycleDays = parseInt(radio.value); break; }
    }

    const totalCNY = price * rate;
    els.priceCNYPreview.textContent = `≈${totalCNY.toFixed(2)}元`;

    // 空 / 非法日期：清空结果区，给出占位提示
    if (isNaN(due.getTime()) || isNaN(trade.getTime())) {
        els.finalValue.textContent = '0.00';
        els.originalCurrencyValue.textContent = '请填写到期日 / 交易日';
        els.daysRemaining.textContent = '--';
        els.progressBar.style.width = '0%';
        els.progressText.textContent = '--';
        return;
    }

    const diffTime = due - trade;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const dailyPrice = cycleDays > 0 ? price / cycleDays : 0;

    let valOrig = 0, valCNY = 0;

    if (diffDays > 0) {
        valOrig = dailyPrice * diffDays;
        valCNY = valOrig * rate;
    }

    // 进度条语义：当前续费周期内的「剩余比例」
    // 当剩余天数 > 一个周期：满格 100%（已续多个周期），文字额外标注 "+N 周期"
    let progressPct;
    let extraCycles = 0;
    if (diffDays <= 0) {
        progressPct = 0;
    } else if (diffDays >= cycleDays) {
        progressPct = 100;
        extraCycles = Math.floor(diffDays / cycleDays);
    } else {
        progressPct = (diffDays / cycleDays) * 100;
    }

    els.progressBar.style.width = `${progressPct}%`;
    els.finalValue.textContent = valCNY.toFixed(2);
    els.originalCurrencyValue.textContent = `≈ ${valOrig.toFixed(2)} ${els.currency.value}`;
    els.daysRemaining.textContent = diffDays > 0 ? diffDays : '0';
    els.progressText.textContent = extraCycles > 0
        ? `100% (+${extraCycles}周期)`
        : `${progressPct.toFixed(1)}%`;
}

function copyResult() {
    const price = els.price.value || "0";
    const currency = els.currency.value;
    const rate = els.customRate.value || "0";
    const days = els.daysRemaining.textContent;
    const valCNY = els.finalValue.textContent;
    const valOrig = els.originalCurrencyValue.textContent.replace('≈', '').trim().split(' ')[0];
    const tradeDate = els.tradeDate.value;
    const dueDate = els.dueDate.value;
    
    let cycleText = "年付";
    for (const radio of els.cycles) {
        if (radio.checked) { 
            cycleText = radio.parentElement.innerText.trim();
            break; 
        }
    }

    const cnyPrice = (parseFloat(price) * parseFloat(rate)).toFixed(2);
    const md = `## 🐔 VPS 剩余价值
- 📅 交易日期：${tradeDate}
- 💹 外币汇率：1 ${currency} ≈ ${rate} CNY
- 💰 续费价格：${price} ${currency}/${cycleText}（约 ${cnyPrice} 元）
- ⏳ 剩余天数：${days}天（${dueDate} 到期）
- 💎 剩余价值：${valCNY}元（约 ${valOrig} ${currency}）`;

    const fallbackCopy = () => {
        const textArea = document.createElement("textarea");
        textArea.value = md;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try { document.execCommand("copy"); } catch (_) {}
        document.body.removeChild(textArea);
    };

    const done = () => {
        flashCopyButton();
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(md).then(done).catch(() => { fallbackCopy(); done(); });
    } else {
        fallbackCopy();
        done();
    }
}

function flashCopyButton() {
    const btn = document.getElementById('copyBtn');
    if (!btn) return;
    const label = btn.querySelector('span');
    const originalText = label ? label.textContent : '';
    btn.classList.add('btn-copied');
    if (label) label.textContent = '已复制 ✓';
    clearTimeout(flashCopyButton._t);
    flashCopyButton._t = setTimeout(() => {
        btn.classList.remove('btn-copied');
        if (label) label.textContent = originalText;
    }, 1500);
}

const modal = {
    el: document.getElementById('imageModal'),
    img: document.getElementById('generatedImage'),
    loading: document.getElementById('modalLoading'),
    actions: document.getElementById('modalActions')
};

function closeImageModal() {
    modal.el.classList.remove('opacity-100');
    setTimeout(() => {
        modal.el.classList.add('hidden');
        modal.img.classList.add('hidden');
        modal.actions.classList.add('hidden');
        modal.loading.classList.remove('hidden');
        modal.img.src = '';
    }, 300);
}

// Close modal on background click
modal.el.addEventListener('click', (e) => {
    if (e.target === modal.el) closeImageModal();
});

async function generateImage() {
    console.log('generateImage called');
    
    // Show modal immediately to indicate processing
    modal.el.classList.remove('hidden');
    // Force reflow
    void modal.el.offsetWidth;
    modal.el.classList.add('opacity-100');
    
    // Use setTimeout to allow UI to update before heavy lifting
    setTimeout(async () => {
        const node = document.getElementById('mainCard');
        const isDark = document.documentElement.classList.contains('dark');
        node.classList.add('exporting');
        const restoreDateInputs = prepareDateInputsForExport(node);
        const restoreNumberInputs = prepareNumberInputsForExport(node);
        const restoreSelectInputs = prepareSelectInputsForExport(node);

        try {
            const htmlToImage = await getHtmlToImage();
            const dataUrl = await htmlToImage.toPng(node, {
                quality: 0.95,
                pixelRatio: 2,
                backgroundColor: isDark ? '#000000' : '#f0f2f5',
                filter: (element) => {
                    if (!element || !element.id) return true;
                    return element.id !== 'btnContainer';
                },
                style: {
                    transform: 'scale(1)',
                }
            });

            console.log('Image generated successfully');
            modal.loading.classList.add('hidden');
            modal.img.src = dataUrl;
            modal.img.classList.remove('hidden');
            modal.actions.classList.remove('hidden');
        } catch (e) {
            console.error('Synchronous error during image generation:', e);
            closeImageModal();
            showToast('生成出错');
        } finally {
            restoreSelectInputs();
            restoreNumberInputs();
            restoreDateInputs();
            node.classList.remove('exporting');
        }
    }, 100);
}

// 用 addEventListener 绑定（替代 inline onclick），保持 HTML 与逻辑解耦
function bindActionButtons() {
    const map = [
        ['copyBtn', copyResult],
        ['imgBtn', generateImage],
        ['closeImageModalBtn', closeImageModal],
    ];
    for (const [id, fn] of map) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindActionButtons);
} else {
    bindActionButtons();
}

