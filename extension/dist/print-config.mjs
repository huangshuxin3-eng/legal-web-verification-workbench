// CDP dimensions are inches. This profile is site-independent.
export const PRINT_PARAMS = Object.freeze({
  landscape: false,
  printBackground: true,
  displayHeaderFooter: true,
  paperWidth: 210 / 25.4,
  paperHeight: 297 / 25.4,
  marginTop: 12 / 25.4,
  marginBottom: 14 / 25.4,
  marginLeft: 10 / 25.4,
  marginRight: 10 / 25.4,
  scale: 1,
  preferCSSPageSize: false,
  pageRanges: "",
  transferMode: "ReturnAsBase64",
});

export function formatCaptureTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} UTC+08:00`;
}

export const FOOTER_TEMPLATE = `<div style="width:100%;box-sizing:border-box;padding:0 10mm;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:8px;line-height:10px;color:#555;display:flex;align-items:flex-start;gap:12px;">
  <span class="url" style="flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-all;"></span>
  <span style="flex:none;white-space:nowrap;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

export function createPrintParams(printedAt = new Date()) {
  // Explicit time zone rather than the locale-dependent CDP `date` placeholder.
  // Only formatted numeric time is interpolated; page title/URL are filled by Chrome.
  return {
    ...PRINT_PARAMS,
    headerTemplate: `<div style="width:100%;box-sizing:border-box;padding:0 10mm;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:8px;line-height:10px;color:#555;display:flex;align-items:flex-start;gap:12px;">
  <span style="flex:none;white-space:nowrap;">${formatCaptureTime(printedAt)}</span>
  <span class="title" style="flex:1;min-width:0;text-align:right;overflow-wrap:anywhere;"></span>
</div>`,
    footerTemplate: FOOTER_TEMPLATE,
  };
}
