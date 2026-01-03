import { PCMPlayerWorklet } from './PCMPlayerWorklet.js';

// Configuration
const MODELS = {
    backbone: './models/soprano_backbone_kv.onnx',
    decoder: './models/soprano_decoder.onnx',
    tokenizer: './models/soprano-tokenizer'
};

const RECEPTIVE_FIELD = 4;
const TOKEN_SIZE = 2048;
const SAMPLE_RATE = 32000;

// ============================================
// Text Preprocessing (ported from soprano/utils/text.py)
// ============================================

// Number to words conversion (simplified inflect replacement)
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_ONES = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth',
    'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const ORDINAL_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];

function numberToWords(num, options = {}) {
    const { andword = '', zero = 'zero', group = 0 } = options;
    if (num === 0) return zero;

    const convert = (n) => {
        if (n < 20) return ONES[n];
        if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
        if (n < 1000) {
            const remainder = n % 100;
            return ONES[Math.floor(n / 100)] + ' hundred' + (remainder ? (andword ? ' ' + andword + ' ' : ' ') + convert(remainder) : '');
        }
        if (n < 1000000) {
            const thousands = Math.floor(n / 1000);
            const remainder = n % 1000;
            return convert(thousands) + ' thousand' + (remainder ? ' ' + convert(remainder) : '');
        }
        if (n < 1000000000) {
            const millions = Math.floor(n / 1000000);
            const remainder = n % 1000000;
            return convert(millions) + ' million' + (remainder ? ' ' + convert(remainder) : '');
        }
        const billions = Math.floor(n / 1000000000);
        const remainder = n % 1000000000;
        return convert(billions) + ' billion' + (remainder ? ' ' + convert(remainder) : '');
    };

    // Special handling for years (group=2 mode)
    if (group === 2 && num > 1000 && num < 10000) {
        const high = Math.floor(num / 100);
        const low = num % 100;
        if (low === 0) {
            return convert(high) + ' hundred';
        } else if (low < 10) {
            return convert(high) + ' ' + (zero === 'oh' ? 'oh' : zero) + ' ' + ONES[low];
        } else {
            return convert(high) + ' ' + convert(low);
        }
    }

    return convert(num);
}

function ordinalToWords(num) {
    if (num < 20) return ORDINAL_ONES[num] || numberToWords(num) + 'th';
    if (num < 100) {
        const tens = Math.floor(num / 10);
        const ones = num % 10;
        if (ones === 0) return ORDINAL_TENS[tens];
        return TENS[tens] + ' ' + ORDINAL_ONES[ones];
    }
    // For larger numbers, just add 'th' to the cardinal
    const cardinal = numberToWords(num);
    if (cardinal.endsWith('y')) return cardinal.slice(0, -1) + 'ieth';
    if (cardinal.endsWith('one')) return cardinal.slice(0, -3) + 'first';
    if (cardinal.endsWith('two')) return cardinal.slice(0, -3) + 'second';
    if (cardinal.endsWith('three')) return cardinal.slice(0, -5) + 'third';
    if (cardinal.endsWith('ve')) return cardinal.slice(0, -2) + 'fth';
    if (cardinal.endsWith('e')) return cardinal.slice(0, -1) + 'th';
    if (cardinal.endsWith('t')) return cardinal + 'h';
    return cardinal + 'th';
}

// Unicode to ASCII mapping (simplified unidecode)
const UNICODE_MAP = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae',
    'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ì': 'i', 'í': 'i',
    'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o',
    'ö': 'o', 'ø': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y',
    'ÿ': 'y', 'ß': 'ss', 'œ': 'oe', 'ð': 'd', 'þ': 'th',
    'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A', 'Æ': 'AE',
    'Ç': 'C', 'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E', 'Ì': 'I', 'Í': 'I',
    'Î': 'I', 'Ï': 'I', 'Ñ': 'N', 'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O',
    'Ö': 'O', 'Ø': 'O', 'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U', 'Ý': 'Y',
    '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '\u2026': '...', '\u2013': '-', '\u2014': '-',
    '\u00AB': '"', '\u00BB': '"', '\u2039': "'", '\u203A': "'", '\u2022': '*', '\u2032': "'", '\u2033': '"'
};

function convertToAscii(text) {
    return text.split('').map(c => UNICODE_MAP[c] || c).join('')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Abbreviations
const ABBREVIATIONS = [
    [/\bmrs\./gi, 'misuss'],
    [/\bms\./gi, 'miss'],
    [/\bmr\./gi, 'mister'],
    [/\bdr\./gi, 'doctor'],
    [/\bst\./gi, 'saint'],
    [/\bco\./gi, 'company'],
    [/\bjr\./gi, 'junior'],
    [/\bmaj\./gi, 'major'],
    [/\bgen\./gi, 'general'],
    [/\bdrs\./gi, 'doctors'],
    [/\brev\./gi, 'reverend'],
    [/\blt\./gi, 'lieutenant'],
    [/\bhon\./gi, 'honorable'],
    [/\bsgt\./gi, 'sergeant'],
    [/\bcapt\./gi, 'captain'],
    [/\besq\./gi, 'esquire'],
    [/\bltd\./gi, 'limited'],
    [/\bcol\./gi, 'colonel'],
    [/\bft\./gi, 'fort'],
];

const CASED_ABBREVIATIONS = [
    [/\bTTS\b/g, 'text to speech'],
    [/\bHz\b/g, 'hertz'],
    [/\bkHz\b/g, 'kilohertz'],
    [/\bKBs\b/g, 'kilobytes'],
    [/\bKB\b/g, 'kilobyte'],
    [/\bMBs\b/g, 'megabytes'],
    [/\bMB\b/g, 'megabyte'],
    [/\bGBs\b/g, 'gigabytes'],
    [/\bGB\b/g, 'gigabyte'],
    [/\bTBs\b/g, 'terabytes'],
    [/\bTB\b/g, 'terabyte'],
    [/\bAPIs\b/g, "a p i's"],
    [/\bAPI\b/g, 'a p i'],
    [/\bCLIs\b/g, "c l i's"],
    [/\bCLI\b/g, 'c l i'],
    [/\bCPUs\b/g, "c p u's"],
    [/\bCPU\b/g, 'c p u'],
    [/\bGPUs\b/g, "g p u's"],
    [/\bGPU\b/g, 'g p u'],
    [/\bAve\b/g, 'avenue'],
    [/\betc\b/g, 'etcetera'],
];

function expandAbbreviations(text) {
    for (const [regex, replacement] of [...ABBREVIATIONS, ...CASED_ABBREVIATIONS]) {
        text = text.replace(regex, replacement);
    }
    return text;
}

// Number normalization patterns
const NUM_PREFIX_RE = /#(\d)/g;
const NUM_SUFFIX_RE = /(\d)([KMBT])/gi;
const NUM_LETTER_SPLIT_RE = /(\d)([a-z])|([a-z])(\d)/gi;
const COMMA_NUMBER_RE = /(\d[\d,]+\d)/g;
const DATE_RE = /(^|[^/])(\d\d?[/-]\d\d?[/-]\d\d(?:\d\d)?)($|[^/])/g;
const PHONE_NUMBER_RE = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]?\d{4}/g;
const TIME_RE = /(\d\d?):(\d\d)(?::(\d\d))?/g;
const POUNDS_RE = /£([\d,]*\d+)/g;
const DOLLARS_RE = /\$([\d.,]*\d+)/g;
const DECIMAL_NUMBER_RE = /(\d+(?:\.\d+)+)/g;
const MULTIPLY_RE = /(\d)\s?\*\s?(\d)/g;
const DIVIDE_RE = /(\d)\s?\/\s?(\d)/g;
const ADD_RE = /(\d)\s?\+\s?(\d)/g;
const SUBTRACT_RE = /(\d)?\s?-\s?(\d)/g;
const FRACTION_RE = /(\d+)\/(\d+)/g;
const ORDINAL_RE = /(\d+)(st|nd|rd|th)/gi;
const NUMBER_RE = /\d+/g;

function normalizeNumbers(text) {
    // Number prefix (#1 -> number 1)
    text = text.replace(NUM_PREFIX_RE, (_, d) => `number ${d}`);

    // Number suffix (100K -> 100 thousand)
    text = text.replace(NUM_SUFFIX_RE, (_, num, suffix) => {
        const map = { k: 'thousand', m: 'million', b: 'billion', t: 'trillion' };
        return `${num} ${map[suffix.toLowerCase()]}`;
    });

    // Split alphanumeric (100x -> 100 x)
    for (let i = 0; i < 2; i++) {
        text = text.replace(NUM_LETTER_SPLIT_RE, (m, d1, l1, l2, d2) => {
            if (d1 && l1) return `${d1} ${l1}`;
            if (l2 && d2) return `${l2} ${d2}`;
            return m;
        });
    }

    // Remove commas from numbers
    text = text.replace(COMMA_NUMBER_RE, m => m.replace(/,/g, ''));

    // Dates
    text = text.replace(DATE_RE, (_, pre, date, post) => {
        const parts = date.split(/[./-]/);
        return pre + parts.join(' dash ') + post;
    });

    // Phone numbers
    text = text.replace(PHONE_NUMBER_RE, m => {
        const digits = m.replace(/\D/g, '');
        if (digits.length === 10) {
            return `${digits.slice(0, 3).split('').join(' ')}, ${digits.slice(3, 6).split('').join(' ')}, ${digits.slice(6).split('').join(' ')}`;
        }
        return m;
    });

    // Time
    text = text.replace(TIME_RE, (_, hours, minutes, seconds) => {
        const h = parseInt(hours);
        const m = parseInt(minutes);
        if (!seconds) {
            if (m === 0) {
                if (h === 0) return '0';
                if (h > 12) return `${hours} minutes`;
                return `${hours} o'clock`;
            }
            if (minutes.startsWith('0')) {
                return `${hours} oh ${minutes[1]}`;
            }
            return `${hours} ${minutes}`;
        }
        const s = parseInt(seconds);
        let result = '';
        if (h !== 0) {
            result = hours + ' ' + (m === 0 ? 'oh oh' : minutes.startsWith('0') ? `oh ${minutes[1]}` : minutes);
            result += ' ' + (s === 0 ? '' : seconds.startsWith('0') ? `oh ${seconds[1]}` : seconds);
        } else if (m !== 0) {
            result = minutes + ' ' + (s === 0 ? 'oh oh' : seconds.startsWith('0') ? `oh ${seconds[1]}` : seconds);
        } else {
            result = seconds;
        }
        return result.trim();
    });

    // Pounds
    text = text.replace(POUNDS_RE, (_, amount) => `${amount.replace(/,/g, '')} pounds`);

    // Dollars
    text = text.replace(DOLLARS_RE, (_, amount) => {
        const parts = amount.replace(/,/g, '').split('.');
        const dollars = parseInt(parts[0]) || 0;
        const cents = parts[1] ? parseInt(parts[1]) : 0;
        if (dollars && cents) {
            return `${dollars} ${dollars === 1 ? 'dollar' : 'dollars'}, ${cents} ${cents === 1 ? 'cent' : 'cents'}`;
        } else if (dollars) {
            return `${dollars} ${dollars === 1 ? 'dollar' : 'dollars'}`;
        } else if (cents) {
            return `${cents} ${cents === 1 ? 'cent' : 'cents'}`;
        }
        return 'zero dollars';
    });

    // Decimal points (1.2.3 -> 1 point 2 point 3)
    text = text.replace(DECIMAL_NUMBER_RE, m => {
        const parts = m.split('.');
        return parts[0] + ' point ' + parts.slice(1).map(p => p.split('').join(' ')).join(' point ');
    });

    // Math operations
    text = text.replace(MULTIPLY_RE, '$1 times $2');
    text = text.replace(DIVIDE_RE, '$1 over $2');
    text = text.replace(ADD_RE, '$1 plus $2');
    text = text.replace(SUBTRACT_RE, (_, a, b) => (a ? a : '') + ' minus ' + b);

    // Fractions (after divide to catch remaining)
    text = text.replace(FRACTION_RE, '$1 over $2');

    // Ordinals
    text = text.replace(ORDINAL_RE, (_, num) => ordinalToWords(parseInt(num)));

    // Plain numbers
    text = text.replace(NUMBER_RE, m => {
        const num = parseInt(m);
        if (num > 1000 && num < 3000) {
            if (num === 2000) return 'two thousand';
            if (num > 2000 && num < 2010) return 'two thousand ' + numberToWords(num % 100);
            if (num % 100 === 0) return numberToWords(Math.floor(num / 100)) + ' hundred';
            return numberToWords(num, { zero: 'oh', group: 2 });
        }
        return numberToWords(num);
    });

    return text;
}

// Special characters
const SPECIAL_CHARACTERS = [
    [/@/g, ' at '],
    [/&/g, ' and '],
    [/%/g, ' percent '],
    [/:/g, '.'],
    [/;/g, ','],
    [/\+/g, ' plus '],
    [/\\/g, ' backslash '],
    [/~/g, ' about '],
    [/(^| )<3/g, ' heart '],
    [/<=/g, ' less than or equal to '],
    [/>=/g, ' greater than or equal to '],
    [/</g, ' less than '],
    [/>/g, ' greater than '],
    [/=/g, ' equals '],
    [/\//g, ' slash '],
    [/_/g, ' '],
];

const LINK_HEADER_RE = /https?:\/\//gi;
const DASH_RE = /(.) - (.)/g;
const DOT_RE = /([A-Z])\.([A-Z])/gi;
const PARENTHESES_RE = /[\(\[\{][^\)\]\}]*[\)\]\}](.)?/g;

function normalizeSpecial(text) {
    text = text.replace(LINK_HEADER_RE, 'h t t p s colon slash slash ');
    text = text.replace(DASH_RE, '$1, $2');
    text = text.replace(DOT_RE, '$1 dot $2');
    text = text.replace(PARENTHESES_RE, (m, after) => {
        let result = m.replace(/[\(\[\{]/g, ', ').replace(/[\)\]\}]/g, ', ');
        if (after && /[$.!?,]/.test(after)) {
            result = result.slice(0, -2) + after;
        }
        return result;
    });
    return text;
}

function expandSpecialCharacters(text) {
    for (const [regex, replacement] of SPECIAL_CHARACTERS) {
        text = text.replace(regex, replacement);
    }
    return text;
}

function normalizeNewlines(text) {
    return text.split('\n').map(line => {
        line = line.trim();
        if (!line) return '';
        if (!/[.!?]$/.test(line)) line += '.';
        return line;
    }).join(' ');
}

function removeUnknownCharacters(text) {
    text = text.replace(/[^A-Za-z !\$%&'\*\+,\-./0123456789<>\?_]/g, '');
    text = text.replace(/[<>\/_+]/g, '');
    return text;
}

function collapseWhitespace(text) {
    text = text.replace(/\s+/g, ' ');
    text = text.replace(/ ([.\?!,])/g, '$1');
    return text;
}

function dedupPunctuation(text) {
    text = text.replace(/\.\.\.+/g, '[ELLIPSIS]');
    text = text.replace(/,+/g, ',');
    text = text.replace(/[.,]*\.[.,]*/g, '.');
    text = text.replace(/[.,!]*![.,!]*/g, '!');
    text = text.replace(/[.,!?]*\?[.,!?]*/g, '?');
    text = text.replace(/\[ELLIPSIS\]/g, '...');
    return text;
}

function cleanText(text) {
    text = convertToAscii(text);
    text = normalizeNewlines(text);
    text = normalizeNumbers(text);
    text = normalizeSpecial(text);
    text = expandAbbreviations(text);
    text = expandSpecialCharacters(text);
    text = text.toLowerCase();
    text = removeUnknownCharacters(text);
    text = collapseWhitespace(text);
    text = dedupPunctuation(text);
    return text.trim();
}

/**
 * Preprocess text for TTS inference.
 * Cleans text, splits into sentences, merges short ones, and batches into groups.
 * @param {string} text - Input text
 * @param {number} batchSize - Number of sentences per batch (default 3)
 * @param {number} minLength - Minimum sentence length before merging (default 30)
 * @returns {string[]} Array of formatted prompts
 */
function preprocessText(text, batchSize = 3, minLength = 30) {
    text = text.trim();
    const cleanedText = cleanText(text);

    // Split into sentences
    let sentences = cleanedText.split(/(?<=[.!?])\s+/).filter(s => s.trim());

    if (sentences.length === 0) {
        return cleanedText ? [`[STOP][TEXT]${cleanedText}[START]`] : [];
    }

    // Merge short sentences
    if (minLength > 0 && sentences.length > 1) {
        const merged = [];
        for (let i = 0; i < sentences.length; i++) {
            const cur = sentences[i];
            if (cur.length < minLength) {
                if (merged.length > 0) {
                    merged[merged.length - 1] = (merged[merged.length - 1] + ' ' + cur).trim();
                } else if (i + 1 < sentences.length) {
                    sentences[i + 1] = (cur + ' ' + sentences[i + 1]).trim();
                } else {
                    merged.push(cur);
                }
            } else {
                merged.push(cur);
            }
        }
        sentences = merged;
    }

    // Batch sentences into groups
    const prompts = [];
    for (let i = 0; i < sentences.length; i += batchSize) {
        const batch = sentences.slice(i, i + batchSize).join(' ');
        prompts.push(`[STOP][TEXT]${batch}[START]`);
    }

    return prompts;
}

// ============================================
// WebGPU Detector
// ============================================
class WebGPUDetector {
    constructor() {
        this.status = 'unknown';
        this.gpuInfo = null;
        this.reason = null;
    }

    async detect() {
        if (!navigator.gpu) {
            this.status = 'unavailable';
            this.reason = this.getBrowserReason();
            return this;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();

            if (!adapter) {
                this.status = 'unavailable';
                this.reason = 'No compatible GPU adapter found';
                return this;
            }

            // Get adapter info if available
            if (adapter.requestAdapterInfo) {
                const info = await adapter.requestAdapterInfo();
                this.gpuInfo = {
                    vendor: info.vendor || 'Unknown',
                    architecture: info.architecture || '',
                    device: info.device || '',
                    description: info.description || ''
                };
            }

            // Verify we can get a device
            const device = await adapter.requestDevice();
            if (device) {
                this.status = 'available';
                device.destroy();
            } else {
                this.status = 'unavailable';
                this.reason = 'Could not acquire GPU device';
            }

        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
        }

        return this;
    }

    getBrowserReason() {
        const ua = navigator.userAgent.toLowerCase();

        if (ua.includes('firefox')) {
            return 'Firefox: Enable in about:config (dom.webgpu.enabled)';
        }
        if (ua.includes('safari') && !ua.includes('chrome')) {
            return 'Safari: WebGPU support is experimental';
        }
        if (ua.includes('chrome') || ua.includes('edge')) {
            return 'Update to Chrome 113+ or Edge 113+ for WebGPU';
        }

        return 'Your browser does not support WebGPU';
    }

    getDisplayName() {
        if (!this.gpuInfo) return null;

        const { vendor, device, description } = this.gpuInfo;

        if (description) return description;
        if (device) return device;
        if (vendor && vendor !== 'Unknown') return `${vendor} GPU`;

        return 'WebGPU Device';
    }
}

// ============================================
// Dual-Layer Visualizer
// ============================================
class DualLayerVisualizer {
    constructor(waveformCanvas, barsCanvas, player) {
        this.waveformCanvas = waveformCanvas;
        this.barsCanvas = barsCanvas;
        this.player = player;

        this.waveformCtx = waveformCanvas.getContext('2d');
        this.barsCtx = barsCanvas.getContext('2d');

        this.isRunning = false;
        this.animationId = null;
        this.dpr = window.devicePixelRatio || 1;

        // Colors
        this.waveformColor = '#3b82f6';
        this.waveformGlow = 'rgba(59, 130, 246, 0.4)';
        this.barGradientStart = '#3b82f6';
        this.barGradientEnd = '#8b5cf6';

        this.setupCanvases();
        this.setupResizeObserver();
    }

    setupResizeObserver() {
        const observer = new ResizeObserver(() => this.setupCanvases());
        observer.observe(this.waveformCanvas.parentElement);
    }

    setupCanvases() {
        const parent = this.waveformCanvas.parentElement;
        const width = parent.offsetWidth;
        const height = parent.offsetHeight;

        [this.waveformCanvas, this.barsCanvas].forEach(canvas => {
            canvas.width = width * this.dpr;
            canvas.height = height * this.dpr;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        });

        this.waveformCtx.scale(this.dpr, this.dpr);
        this.barsCtx.scale(this.dpr, this.dpr);

        this.width = width;
        this.height = height;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.draw();
    }

    stop() {
        this.isRunning = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    draw() {
        if (!this.isRunning) return;

        this.drawWaveform();
        this.drawFrequencyBars();

        this.animationId = requestAnimationFrame(() => this.draw());
    }

    drawWaveform() {
        const ctx = this.waveformCtx;
        const { width, height } = this;

        const data = this.player.getTimeDomainData();
        if (!data) {
            ctx.clearRect(0, 0, width, height);
            // Draw flat line when idle
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
            ctx.lineWidth = 1;
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
            return;
        }

        ctx.clearRect(0, 0, width, height);

        // Draw glow layer first
        ctx.save();
        ctx.shadowBlur = 20;
        ctx.shadowColor = this.waveformGlow;

        ctx.beginPath();
        ctx.strokeStyle = this.waveformColor;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const sliceWidth = width / data.length;
        let x = 0;

        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0;
            const y = (v * height) / 2;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                // Use quadratic curves for smoother lines
                const prevX = x - sliceWidth;
                const prevV = data[i - 1] / 128.0;
                const prevY = (prevV * height) / 2;
                const cpX = (prevX + x) / 2;
                const cpY = (prevY + y) / 2;
                ctx.quadraticCurveTo(prevX, prevY, cpX, cpY);
            }
            x += sliceWidth;
        }

        ctx.stroke();
        ctx.restore();
    }

    drawFrequencyBars() {
        const ctx = this.barsCtx;
        const { width, height } = this;

        const data = this.player.getAnalyserData();

        ctx.clearRect(0, 0, width, height);

        if (!data) return;

        const barCount = 48;
        const barWidth = (width / barCount) * 0.6;
        const gap = (width / barCount) * 0.4;

        // Sample the frequency data
        const step = Math.floor(data.length / barCount);

        for (let i = 0; i < barCount; i++) {
            const value = data[i * step] / 255;
            const barHeight = Math.max(2, value * height * 0.7);

            const x = i * (barWidth + gap) + gap / 2;
            const y = height - barHeight;

            // Create gradient for each bar
            const gradient = ctx.createLinearGradient(x, height, x, y);
            gradient.addColorStop(0, this.barGradientStart);
            gradient.addColorStop(1, this.barGradientEnd);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
            ctx.fill();
        }
    }
}

// ============================================
// Main Application
// ============================================
class SopranoONNXStreaming {
    constructor() {
        this.backboneSession = null;
        this.decoderSession = null;
        this.tokenizer = null;
        this.player = null;
        this.visualizer = null;
        this.isGenerating = false;
        this.abortController = null;
        this.audioContext = null;
        this.webgpuDetector = new WebGPUDetector();
        this.selectedDevice = 'webgpu';

        // UI Elements
        this.elements = {
            textInput: document.getElementById('text-input'),
            charCount: document.getElementById('char-count'),
            generateBtn: document.getElementById('generate-btn'),
            stopBtn: document.getElementById('stop-btn'),
            btnLoader: document.getElementById('btn-loader'),
            cpuCard: document.getElementById('device-cpu'),
            gpuCard: document.getElementById('device-gpu'),
            gpuBanner: document.getElementById('gpu-banner'),
            gpuBannerTitle: document.getElementById('gpu-banner-title'),
            gpuBannerMessage: document.getElementById('gpu-banner-message'),
            statusIndicator: document.getElementById('status-indicator'),
            statStatus: document.getElementById('stat-status'),
            statTTFB: document.getElementById('stat-ttfb'),
            ttfbBar: document.getElementById('ttfb-bar'),
            statRTFx: document.getElementById('stat-rtfx'),
            rtfxContext: document.getElementById('rtfx-context'),
            modelStatus: document.getElementById('model-status'),
            waveformCanvas: document.getElementById('visualizer-waveform'),
            barsCanvas: document.getElementById('visualizer-bars'),
            sampleBtns: document.querySelectorAll('.sample-btn')
        };

        // Sampling params (match soprano/tts.py defaults)
        this.temperature = 0.3;
        // NOTE: HF `generate` defaults `top_k=50` unless overridden.
        this.topK = 50;
        this.topP = 0.95;
        this.repetitionPenalty = 1.2;

        // Cached buffers for top-k/top-p sampling (allocated lazily).
        this._topKIndices = null;
        this._topKScores = null;
        this._topKOrder = null;
        this._topKExp = null;

        this.init();
    }

    async init() {
        console.log('SopranoONNXStreaming v3.0 - Neural Observatory Edition');
        this.updateStatus('Initializing...', 'running');

        try {
            // 1. Detect WebGPU
            await this.webgpuDetector.detect();
            this.setupDeviceSelector();

            // 2. Initialize Audio Context and Player
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE
            });
            this.player = new PCMPlayerWorklet(this.audioContext, {
                minBufferBeforePlaybackMs: 150
            });

            // 3. Initialize Visualizer
            this.visualizer = new DualLayerVisualizer(
                this.elements.waveformCanvas,
                this.elements.barsCanvas,
                this.player
            );
            this.visualizer.start();

            // 4. Load Tokenizer
            const { AutoTokenizer, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0');
            env.allowLocalModels = true;
            env.allowRemoteModels = false;
            env.localModelPath = new URL('.', window.location.href).pathname;

            const tokenizerPath = 'models/soprano-tokenizer';
            console.log(`Loading tokenizer from: ${tokenizerPath}`);
            this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath, {
                local_files_only: true
            });

            this.updateStatus('Ready', 'idle');
            this.setupEventListeners();

        } catch (err) {
            console.error('Initialization failed:', err);
            this.updateStatus('Init Error', 'error');
        }
    }

    setupDeviceSelector() {
        const { status, reason } = this.webgpuDetector;
        const gpuName = this.webgpuDetector.getDisplayName();

        if (status === 'available') {
            // WebGPU is available
            this.elements.gpuBanner.hidden = false;
            this.elements.gpuBanner.classList.add('gpu-banner--available');
            this.elements.gpuBannerTitle.textContent = 'WebGPU Available';
            this.elements.gpuBannerMessage.textContent = gpuName ? `Detected: ${gpuName}` : 'Hardware acceleration enabled';

            this.selectDevice('webgpu');
            console.log('WebGPU available:', gpuName || 'Unknown GPU');
        } else {
            // WebGPU not available
            this.elements.gpuBanner.hidden = false;
            this.elements.gpuBanner.classList.add('gpu-banner--unavailable');
            this.elements.gpuBannerTitle.textContent = 'WebGPU Unavailable';
            this.elements.gpuBannerMessage.textContent = reason || 'Using CPU fallback';

            // Disable GPU card
            this.elements.gpuCard.setAttribute('aria-disabled', 'true');
            this.selectDevice('wasm');
            console.warn('WebGPU not available:', reason);
        }
    }

    selectDevice(device) {
        if (device === 'webgpu' && this.webgpuDetector.status !== 'available') {
            return;
        }

        this.selectedDevice = device;

        // Update ARIA states
        this.elements.cpuCard.setAttribute('aria-checked', device === 'wasm');
        this.elements.gpuCard.setAttribute('aria-checked', device === 'webgpu');

        console.log('Selected device:', device);
    }

    setupEventListeners() {
        // Device cards
        this.elements.cpuCard.addEventListener('click', () => this.selectDevice('wasm'));
        this.elements.gpuCard.addEventListener('click', () => {
            if (this.webgpuDetector.status === 'available') {
                this.selectDevice('webgpu');
            }
        });

        // Keyboard navigation for device cards
        [this.elements.cpuCard, this.elements.gpuCard].forEach(card => {
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    card.click();
                }
            });
        });

        // Generate and stop buttons
        this.elements.generateBtn.addEventListener('click', () => this.startGeneration());
        this.elements.stopBtn.addEventListener('click', () => this.stopGeneration());

        // Character counter
        this.elements.textInput.addEventListener('input', () => {
            this.elements.charCount.textContent = this.elements.textInput.value.length;
        });

        // Sample text buttons
        this.elements.sampleBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const text = btn.dataset.text;
                this.elements.textInput.value = text;
                this.elements.charCount.textContent = text.length;
            });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!this.isGenerating) {
                    this.startGeneration();
                }
            }
            if (e.key === 'Escape' && this.isGenerating) {
                e.preventDefault();
                this.stopGeneration();
            }
        });
    }

    updateStatus(text, state) {
        this.elements.statStatus.textContent = text;
        this.elements.statusIndicator.className = `status-indicator status-indicator--${state}`;
    }

    updateModelStatus(state, text) {
        const modelStatus = this.elements.modelStatus;
        modelStatus.className = `model-status model-status--${state}`;
        modelStatus.querySelector('.model-status__text').textContent = text;
    }

    updateTTFB(valueMs) {
        this.elements.statTTFB.textContent = Math.round(valueMs);

        // Update bar (scale: 0-2000ms = 0-100%, inverted so lower is better)
        const barPercent = Math.min(100, 100 - (valueMs / 2000) * 100);
        this.elements.ttfbBar.style.width = `${barPercent}%`;
    }

    updateRTFx(value) {
        this.elements.statRTFx.textContent = value.toFixed(2);

        const context = this.elements.rtfxContext;
        if (value >= 5) {
            context.textContent = `Excellent! ${value.toFixed(1)}x real-time`;
            context.style.color = '#10b981';
        } else if (value >= 2) {
            context.textContent = 'Good real-time performance';
            context.style.color = '#10b981';
        } else if (value >= 1) {
            context.textContent = 'Real-time streaming active';
            context.style.color = '#94a3b8';
        } else {
            context.textContent = 'Below real-time (buffering)';
            context.style.color = '#f59e0b';
        }
    }

    async loadModels(executionProvider) {
        if (this.backboneSession && this.currentProvider === executionProvider) return;

        this.updateStatus(`Loading (${executionProvider})...`, 'running');
        this.updateModelStatus('loading', 'Loading...');
        this.elements.btnLoader.style.display = 'block';
        this.elements.generateBtn.disabled = true;

        try {
            const sessionOptions = {
                executionProviders: [executionProvider],
                freeDimensionOverrides: { 'batch': 1 }
            };

            console.log(`Loading sessions with ${executionProvider}...`);
            this.backboneSession = await ort.InferenceSession.create(MODELS.backbone, sessionOptions);

            // Manual fetch for decoder and its external data
            console.log('Fetching decoder files...');
            const decoderUrl = MODELS.decoder;
            const dataUrl = decoderUrl + '.data';

            const [decoderBuf, dataBuf] = await Promise.all([
                fetch(decoderUrl).then(r => r.arrayBuffer()),
                fetch(dataUrl).then(r => r.arrayBuffer())
            ]);

            sessionOptions.externalData = [
                {
                    data: new Uint8Array(dataBuf),
                    path: 'soprano_decoder.onnx.data'
                }
            ];

            this.decoderSession = await ort.InferenceSession.create(new Uint8Array(decoderBuf), sessionOptions);
            this.currentProvider = executionProvider;

            this.updateModelStatus('ready', `Ready (${executionProvider.toUpperCase()})`);
            console.log('Models loaded successfully.');
        } catch (err) {
            console.error('Model loading failed:', err);
            this.updateModelStatus('error', 'Load failed');
            throw err;
        } finally {
            this.elements.btnLoader.style.display = 'none';
            this.elements.generateBtn.disabled = false;
        }
    }

    async startGeneration() {
        if (this.isGenerating) return;

        // Resume audio context
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        const text = this.elements.textInput.value.trim();
        if (!text) return;

        this.isGenerating = true;
        this.elements.generateBtn.disabled = true;
        this.elements.generateBtn.classList.add('btn--generating');
        this.elements.stopBtn.disabled = false;
        this.elements.btnLoader.style.display = 'block';

        const provider = this.selectedDevice;

        try {
            await this.loadModels(provider);
            this.updateStatus('Generating...', 'running');

            // Reset player and stats
            this.player.reset();
            this.elements.statTTFB.textContent = '--';
            this.elements.statRTFx.textContent = '--';
            this.elements.ttfbBar.style.width = '0%';
            this.elements.rtfxContext.textContent = '>1x = faster than real-time';
            this.elements.rtfxContext.style.color = '#64748b';

            const overallStartTime = performance.now();
            let isFirstBatch = true;
            let cumulativeSamples = 0;

            // Preprocess text (normalize, split into batches of 3 sentences)
            const prompts = preprocessText(text);

            // Generate audio for each batch
            for (const prompt of prompts) {
                if (!this.isGenerating) break;

                const { input_ids } = await this.tokenizer(prompt);
                const batchSamples = await this.generationLoop(input_ids.data, overallStartTime, isFirstBatch, cumulativeSamples);
                cumulativeSamples += batchSamples;
                isFirstBatch = false;
            }

            if (this.player.notifyStreamEnded) this.player.notifyStreamEnded();
            this.updateStatus('Finished', 'idle');
        } catch (err) {
            console.error('Generation failed:', err);
            this.updateStatus('Error', 'error');
        } finally {
            this.isGenerating = false;
            this.elements.generateBtn.disabled = false;
            this.elements.generateBtn.classList.remove('btn--generating');
            this.elements.stopBtn.disabled = true;
            this.elements.btnLoader.style.display = 'none';
        }
    }

	    async generationLoop(promptTokens, startTime, isFirstBatch = true, cumulativeSamples = 0) {
	        const batch = 1;
	        const numLayers = 17;
	        const hiddenDim = 128;
	        const promptLen = promptTokens.length;
	        const vocabSize = 8192;
	        const maxNewTokens = 512;

	        // Track unique tokens for repetition penalty (HF behavior: includes prompt tokens by default).
	        const seenTokenMask = new Uint8Array(vocabSize);
	        for (let i = 0; i < promptTokens.length; i++) {
	            const tid = Number(promptTokens[i]);
            if (tid >= 0 && tid < vocabSize && seenTokenMask[tid] === 0) {
                seenTokenMask[tid] = 1;
            }
        }

        // Initialize KV cache
        let pastKeyValues = {};
	        for (let i = 0; i < numLayers; i++) {
	            pastKeyValues[`past_key_values.${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [batch, 1, 0, hiddenDim]);
	            pastKeyValues[`past_key_values.${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [batch, 1, 0, hiddenDim]);
	        }

	        // Preallocate attention mask buffer once (avoid O(seq_len) alloc per token).
	        const maxSeqLen = promptLen + maxNewTokens;
	        const attentionMaskData = new BigInt64Array(maxSeqLen);
	        attentionMaskData.fill(1n);
	        let currentSeqLen = promptLen;

	        // Reusable 1-token tensors for decoding steps.
	        const nextInputIdData = new BigInt64Array(1);
	        const nextPositionIdData = new BigInt64Array(1);
	        const nextInputIdsTensor = new ort.Tensor('int64', nextInputIdData, [batch, 1]);
	        const nextPositionIdsTensor = new ort.Tensor('int64', nextPositionIdData, [batch, 1]);

	        let currentInputIds = new ort.Tensor('int64', BigInt64Array.from(promptTokens), [batch, promptLen]);
	        let currentAttentionMask = new ort.Tensor('int64', attentionMaskData.subarray(0, currentSeqLen), [batch, currentSeqLen]);
	        let currentPositionIds = new ort.Tensor('int64', BigInt64Array.from({ length: promptLen }, (_, i) => BigInt(i)), [batch, promptLen]);

	        const hiddenStatesBuffer = [];
	        let totalSamples = 0;

	        const targetChunkSize = 8;
	        let chunkCounter = targetChunkSize;
	        let firstChunk = true;

        for (let i = 0; i < maxNewTokens; i++) {
            if (!this.isGenerating) break;

            // Yield to main thread
            await new Promise(resolve => setTimeout(resolve, 0));

            const inputs = {
                input_ids: currentInputIds,
                attention_mask: currentAttentionMask,
                position_ids: currentPositionIds,
                ...pastKeyValues
            };

            const outputs = await this.backboneSession.run(inputs);

            const backboneNames = this.backboneSession.outputNames;
            const logits = outputs[backboneNames[0]];
            const lastHiddenState = outputs[backboneNames[backboneNames.length - 1]];

            // Update KV cache
            for (let j = 0; j < numLayers; j++) {
                pastKeyValues[`past_key_values.${j}.key`] = outputs[backboneNames[1 + j * 2]];
                pastKeyValues[`past_key_values.${j}.value`] = outputs[backboneNames[2 + j * 2]];
            }

            // Sample next token
            const nextTokenId = this.sample(logits, seenTokenMask);
            const finished = (nextTokenId === 3n);
            const nextTokenIdNum = Number(nextTokenId);
            if (nextTokenIdNum >= 0 && nextTokenIdNum < vocabSize && seenTokenMask[nextTokenIdNum] === 0) {
                seenTokenMask[nextTokenIdNum] = 1;
            }

            // Extract hidden state
            const seqLen = lastHiddenState.dims[1];
            const hiddenDimSize = lastHiddenState.dims[2];
            const lastTokenState = lastHiddenState.data.slice((seqLen - 1) * hiddenDimSize, seqLen * hiddenDimSize);

            if (i > 0 && !finished) {
                hiddenStatesBuffer.push(new Float32Array(lastTokenState));
            }

            // Trim buffer
            if (hiddenStatesBuffer.length > 2 * RECEPTIVE_FIELD + targetChunkSize) {
                hiddenStatesBuffer.splice(0, hiddenStatesBuffer.length - (2 * RECEPTIVE_FIELD + targetChunkSize));
            }

            // Decode trigger
            if (finished || hiddenStatesBuffer.length >= RECEPTIVE_FIELD + targetChunkSize) {
                if (finished || chunkCounter === targetChunkSize) {
                    const window = hiddenStatesBuffer.slice(-hiddenStatesBuffer.length);
                    const currentWindowSize = window.length;

                    const decoderInput = new Float32Array(512 * currentWindowSize);
                    for (let w = 0; w < currentWindowSize; w++) {
                        for (let d = 0; d < 512; d++) {
                            decoderInput[d * currentWindowSize + w] = window[w][d];
                        }
                    }

                    const decoderOutputs = await this.decoderSession.run({
                        [this.decoderSession.inputNames[0]]: new ort.Tensor('float32', decoderInput, [1, 512, currentWindowSize])
                    });

                    const audio = decoderOutputs[this.decoderSession.outputNames[0]].data;

                    let audioChunk;
                    if (finished) {
                        const startIdx = audio.length - (RECEPTIVE_FIELD + chunkCounter - 1) * TOKEN_SIZE + TOKEN_SIZE;
                        audioChunk = audio.subarray(startIdx);
                    } else {
                        const startIdx = audio.length - (RECEPTIVE_FIELD + targetChunkSize) * TOKEN_SIZE + TOKEN_SIZE;
                        const endIdx = audio.length - RECEPTIVE_FIELD * TOKEN_SIZE + TOKEN_SIZE;
                        audioChunk = audio.subarray(startIdx, endIdx);
                    }

                    this.player.playAudio(audioChunk);
                    totalSamples += audioChunk.length;

                    // Update metrics
                    const samplesNow = totalSamples;
                    const isFirst = firstChunk && isFirstBatch;
                    firstChunk = false;
                    requestAnimationFrame(() => {
                        if (isFirst) {
                            this.updateTTFB(performance.now() - startTime);
                        }
                        const elapsed = (performance.now() - startTime) / 1000;
                        const totalDuration = (cumulativeSamples + samplesNow) / SAMPLE_RATE;
                        this.updateRTFx(totalDuration / elapsed);
                    });

                    chunkCounter = 0;
                }

                chunkCounter++;
            }

            if (finished) {
                console.log('Detected [STOP] token.');
                break;
            }

	            // Update inputs for next step
	            nextInputIdData[0] = nextTokenId;
	            currentInputIds = nextInputIdsTensor;

	            currentSeqLen += 1;
	            currentAttentionMask = new ort.Tensor('int64', attentionMaskData.subarray(0, currentSeqLen), [batch, currentSeqLen]);

	            nextPositionIdData[0] = BigInt(currentSeqLen - 1);
	            currentPositionIds = nextPositionIdsTensor;
	        }

	        return totalSamples;
	    }

    sample(logitsTensor, seenTokenMask = null) {
        const data = logitsTensor.data;
        const vocabSize = logitsTensor.dims[2];
        const lastStepOffset = (logitsTensor.dims[1] - 1) * vocabSize;

        const temperature = (this.temperature ?? 1.0);
        const topK = (this.topK ?? 0);
        const topP = (this.topP ?? 1.0);
        const repetitionPenalty = (this.repetitionPenalty ?? 1.0);

        const useRepetitionPenalty = Boolean(seenTokenMask) && repetitionPenalty && repetitionPenalty !== 1.0;
        const invTemperature = (temperature > 0 && temperature !== 1.0) ? (1.0 / temperature) : 1.0;
        const invRepetitionPenalty = (useRepetitionPenalty ? (1.0 / repetitionPenalty) : 1.0);
        const hasTopP = (topP != null && topP < 1.0);

        // Fast path: Top-k first (HF default is 50), then top-p over that subset.
        const k = (topK && topK > 0) ? Math.min(topK, vocabSize) : vocabSize;
        if (k > 0 && k < vocabSize) {
            if (!this._topKIndices || this._topKIndices.length !== k) {
                this._topKIndices = new Int32Array(k);
                this._topKScores = new Float32Array(k);
                this._topKExp = new Float64Array(k);
                this._topKOrder = Array.from({ length: k }, (_, i) => i);
            }

            const heapIndices = this._topKIndices;
            const heapScores = this._topKScores;
            const expBuf = this._topKExp;
            const order = this._topKOrder;

            let heapSize = 0;

            // Build a min-heap of size k containing the top-k scores.
            for (let tokenId = 0; tokenId < vocabSize; tokenId++) {
                let s = data[lastStepOffset + tokenId] * invTemperature;
                if (useRepetitionPenalty && seenTokenMask[tokenId]) {
                    s = s < 0 ? (s * repetitionPenalty) : (s * invRepetitionPenalty);
                }

                if (heapSize < k) {
                    // Sift-up insert.
                    let pos = heapSize++;
                    while (pos > 0) {
                        const parent = (pos - 1) >> 1;
                        const parentScore = heapScores[parent];
                        if (parentScore <= s) break;
                        heapScores[pos] = parentScore;
                        heapIndices[pos] = heapIndices[parent];
                        pos = parent;
                    }
                    heapScores[pos] = s;
                    heapIndices[pos] = tokenId;
                } else if (s > heapScores[0]) {
                    // Replace root and sift-down.
                    let pos = 0;
                    const half = k >> 1;
                    while (pos < half) {
                        let left = (pos << 1) + 1;
                        let right = left + 1;
                        let smallest = left;
                        if (right < k && heapScores[right] < heapScores[left]) smallest = right;
                        if (heapScores[smallest] >= s) break;
                        heapScores[pos] = heapScores[smallest];
                        heapIndices[pos] = heapIndices[smallest];
                        pos = smallest;
                    }
                    heapScores[pos] = s;
                    heapIndices[pos] = tokenId;
                }
            }

            // Sort the top-k set by score descending (k is small, so this is cheap).
            for (let i = 0; i < k; i++) order[i] = i;
            order.sort((a, b) => heapScores[b] - heapScores[a]);

            const maxScore = heapScores[order[0]];
            let sumExp = 0;
            for (let i = 0; i < k; i++) {
                const w = Math.exp(heapScores[order[i]] - maxScore);
                expBuf[i] = w;
                sumExp += w;
            }

            if (!(sumExp > 0) || !Number.isFinite(sumExp)) {
                return BigInt(heapIndices[order[0]]);
            }

            let keep = k;
            let totalWeight = sumExp;
            if (hasTopP) {
                const threshold = topP * sumExp;
                let cumulative = 0;
                let kept = 0;
                for (let i = 0; i < k; i++) {
                    cumulative += expBuf[i];
                    kept++;
                    if (kept >= 1 && cumulative >= threshold) break;
                }
                keep = kept;
                totalWeight = cumulative;
            }

            let r = Math.random() * totalWeight;
            for (let i = 0; i < keep; i++) {
                r -= expBuf[i];
                if (r <= 0) return BigInt(heapIndices[order[i]]);
            }
            return BigInt(heapIndices[order[0]]);
        }

        // Fallback: sample from the full softmax distribution (no full-vocab sorting).
        let maxScore = -Infinity;
        let bestTokenId = 0;
        for (let tokenId = 0; tokenId < vocabSize; tokenId++) {
            let s = data[lastStepOffset + tokenId] * invTemperature;
            if (useRepetitionPenalty && seenTokenMask[tokenId]) {
                s = s < 0 ? (s * repetitionPenalty) : (s * invRepetitionPenalty);
            }
            if (s > maxScore) {
                maxScore = s;
                bestTokenId = tokenId;
            }
        }

        let sumExp = 0;
        for (let tokenId = 0; tokenId < vocabSize; tokenId++) {
            let s = data[lastStepOffset + tokenId] * invTemperature;
            if (useRepetitionPenalty && seenTokenMask[tokenId]) {
                s = s < 0 ? (s * repetitionPenalty) : (s * invRepetitionPenalty);
            }
            sumExp += Math.exp(s - maxScore);
        }

        if (!(sumExp > 0) || !Number.isFinite(sumExp)) {
            // Degenerate distribution: fall back to argmax.
            let best = 0;
            let bestScore = -Infinity;
            for (let tokenId = 0; tokenId < vocabSize; tokenId++) {
                let s = data[lastStepOffset + tokenId] * invTemperature;
                if (useRepetitionPenalty && seenTokenMask[tokenId]) {
                    s = s < 0 ? (s * repetitionPenalty) : (s * invRepetitionPenalty);
                }
                if (s > bestScore) {
                    bestScore = s;
                    best = tokenId;
                }
            }
            return BigInt(best);
        }

        let r = Math.random() * sumExp;
        for (let tokenId = 0; tokenId < vocabSize; tokenId++) {
            let s = data[lastStepOffset + tokenId] * invTemperature;
            if (useRepetitionPenalty && seenTokenMask[tokenId]) {
                s = s < 0 ? (s * repetitionPenalty) : (s * invRepetitionPenalty);
            }
            r -= Math.exp(s - maxScore);
            if (r <= 0) return BigInt(tokenId);
        }
        return BigInt(bestTokenId);
    }

    stopGeneration() {
        this.isGenerating = false;
        if (this.player) {
            this.player.reset();
        }
        this.updateStatus('Stopped', 'idle');
    }
}

// Initialize on load
window.addEventListener('load', () => {
    new SopranoONNXStreaming();
});
