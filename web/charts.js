// Gráficos em SVG, desenhados a partir dos dados reais. Sem bibliotecas.
// Regras: marcas finas, pontas arredondadas de 4px, grade discreta, tooltip no hover/toque.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return s * p;
  }

  function tooltip(host) {
    let t = host.querySelector('.chart-tip');
    if (!t) { t = document.createElement('div'); t.className = 'chart-tip'; host.appendChild(t); }
    return {
      show(html, x, y) {
        t.innerHTML = html; t.style.opacity = '1';
        const w = host.clientWidth, tw = t.offsetWidth;
        t.style.left = Math.max(4, Math.min(w - tw - 4, x - tw / 2)) + 'px';
        t.style.top = Math.max(0, y - t.offsetHeight - 10) + 'px';
      },
      hide() { t.style.opacity = '0'; }
    };
  }

  function empty(host, msg) {
    host.innerHTML = `<div class="chart-empty">${msg}</div>`;
  }

  // data: [{label, value, tip}]
  function bars(host, data, opts = {}) {
    const color = opts.color || 'var(--accent)';
    const fmt = opts.fmt || (v => String(Math.round(v)));
    if (!data.length || data.every(d => !d.value)) return empty(host, opts.empty || 'Sem dados ainda');
    host.innerHTML = '';
    host.classList.add('chart');
    const W = Math.max(260, Math.round(host.clientWidth || 320)), H = opts.height || (W > 600 ? 200 : 150), padL = 34, padB = 22, padT = 8;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Gráfico de barras' }, host);
    const max = niceMax(Math.max(...data.map(d => d.value || 0)));
    const ih = H - padB - padT, iw = W - padL - 4;
    for (let i = 0; i <= 2; i++) {
      const y = padT + ih - (ih * i) / 2;
      el('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid' }, svg);
      el('text', { x: padL - 6, y: y + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmt((max * i) / 2);
    }
    const step = iw / data.length, bw = Math.min(28, step * 0.56);
    const tip = tooltip(host);
    data.forEach((d, i) => {
      const x = padL + step * i + (step - bw) / 2;
      const h = d.value > 0 ? Math.max(3, (ih * d.value) / max) : 0;
      const y = padT + ih - h;
      if (h > 0) {
        const r = Math.min(4, bw / 2, h);
        el('path', {
          d: `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z`,
          fill: d.color || (d.highlight === false ? 'var(--track)' : color), class: 'bar'
        }, svg);
      }
      if (i % Math.max(1, Math.ceil(44 / step)) === 0)
        el('text', { x: x + bw / 2, y: H - 6, class: 'axis', 'text-anchor': 'middle' }, svg).textContent = d.label;
      const hit = el('rect', { x: padL + step * i, y: padT, width: step, height: ih, fill: 'transparent', class: 'hit' }, svg);
      const on = () => {
        const r = host.getBoundingClientRect(), s = svg.getBoundingClientRect();
        tip.show(d.tip || `<b>${fmt(d.value)}</b> ${d.label}`, ((x + bw / 2) / W) * s.width + (s.left - r.left), (y / H) * s.height + (s.top - r.top));
      };
      hit.addEventListener('pointerenter', on); hit.addEventListener('pointerdown', on);
      hit.addEventListener('pointerleave', () => tip.hide());
    });
  }

  // points: [{label, value, tip}] em ordem cronológica
  function line(host, points, opts = {}) {
    const color = opts.color || 'var(--accent)';
    const fmt = opts.fmt || (v => String(Math.round(v * 10) / 10));
    if (points.length < 2) return empty(host, opts.empty || 'Registre pelo menos duas vezes para ver a evolução');
    host.innerHTML = '';
    host.classList.add('chart');
    const W = Math.max(260, Math.round(host.clientWidth || 320)), H = opts.height || (W > 600 ? 200 : 150), padL = 34, padB = 22, padT = 10;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Gráfico de linha' }, host);
    const vals = points.map(p => p.value);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (opts.zero) lo = 0;
    const span = hi - lo || Math.max(1, hi * 0.1);
    lo = opts.zero ? 0 : lo - span * 0.15; hi = hi + span * 0.15;
    const ih = H - padB - padT, iw = W - padL - 10;
    const X = i => padL + 4 + (iw * i) / (points.length - 1);
    const Y = v => padT + ih - ((v - lo) / (hi - lo)) * ih;
    for (let i = 0; i <= 2; i++) {
      const v = lo + ((hi - lo) * i) / 2, y = Y(v);
      el('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid' }, svg);
      el('text', { x: padL - 6, y: y + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmt(v);
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
    el('path', { d: `${d} L${X(points.length - 1)},${padT + ih} L${X(0)},${padT + ih} Z`, fill: color, opacity: 0.08 }, svg);
    el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const every = Math.ceil(points.length / 6);
    points.forEach((p, i) => {
      if (i % every === 0 || i === points.length - 1)
        el('text', { x: X(i), y: H - 6, class: 'axis', 'text-anchor': 'middle' }, svg).textContent = p.label;
    });
    const last = points.length - 1;
    el('circle', { cx: X(last), cy: Y(points[last].value), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    const cross = el('line', { y1: padT, y2: padT + ih, class: 'cross', opacity: 0 }, svg);
    const dot = el('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }, svg);
    const tip = tooltip(host);
    const hit = el('rect', { x: padL, y: 0, width: W - padL, height: H, fill: 'transparent', class: 'hit' }, svg);
    const move = ev => {
      const s = svg.getBoundingClientRect(), r = host.getBoundingClientRect();
      const vx = ((ev.clientX - s.left) / s.width) * W;
      let i = Math.round(((vx - padL - 4) / iw) * (points.length - 1));
      i = Math.max(0, Math.min(last, i));
      const p = points[i];
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(p.value)); dot.setAttribute('opacity', 1);
      tip.show(p.tip || `<b>${fmt(p.value)}</b> · ${p.label}`, (X(i) / W) * s.width + (s.left - r.left), (Y(p.value) / H) * s.height + (s.top - r.top));
    };
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); });
  }

  // Redesenha ao mudar a largura (os gráficos usam a largura real do container).
  const live = new Map();
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => live.forEach((args, host) => { if (host.isConnected) args[0](host, args[1], args[2]); else live.delete(host); }), 150); });
  const track = fn => (host, data, opts) => { live.set(host, [fn, data, opts]); fn(host, data, opts); };
  window.Charts = { bars: track(bars), line: track(line) };
})();
