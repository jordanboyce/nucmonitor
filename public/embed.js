(function () {
  var script = document.currentScript;
  if (!script || !script.parentNode) return;

  var src = script.getAttribute('src') || '';
  var panel = script.getAttribute('data-panel') || 'map';
  var theme = script.getAttribute('data-theme') || 'dark';
  var heightRaw = parseInt(script.getAttribute('data-height') || '420', 10);
  var height = isFinite(heightRaw) ? Math.max(120, Math.min(1200, heightRaw)) : 420;

  var origin;
  try {
    origin = new URL(src, window.location.href).origin;
  } catch (err) {
    return;
  }

  var iframe = document.createElement('iframe');
  var url = origin + '/embed?panel=' + encodeURIComponent(panel) + '&theme=' + encodeURIComponent(theme);
  // Map view state, passed through rather than defaulted, so the loader snippet
  // renders the same selection as the plain iframe snippet. /embed validates
  // and clamps each of these, so a malformed value falls back to the same
  // default it would have without the attribute. Every embed is keyless; a
  // legacy data-key attribute is ignored.
  ['layers', 'center', 'zoom', 'variant'].forEach(function (name) {
    var raw = script.getAttribute('data-' + name);
    var value = (raw || '').trim();
    if (value || (name === 'layers' && raw !== null)) url += '&' + name + '=' + encodeURIComponent(value);
  });
  iframe.title = 'NucMonitor embed';
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'width:100%;height:' + height + 'px;border:0;display:block';

  iframe.src = url;
  script.parentNode.insertBefore(iframe, script.nextSibling);
})();
