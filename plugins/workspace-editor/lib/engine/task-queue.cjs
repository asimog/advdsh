'use strict'

/** Escape one XML text node. @param {unknown} value - text. @returns {string} escaped text. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param {string} value - path. @returns {string} forward-slash path. */
function slashes(value) {
  return String(value).replace(/\\/g, '/')
}

/**
 * Build the x2t TaskQueueDataConvert parameter XML.
 * @param {{ from: string, to: string, format: number|string, tempDir: string, extra?: string }} job - conversion.
 * @returns {string} parameter XML.
 */
function taskQueueXml(job) {
  return `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<m_sFileFrom>${xmlEscape(slashes(job.from))}</m_sFileFrom>
<m_sFileTo>${xmlEscape(slashes(job.to))}</m_sFileTo>
<m_nFormatTo>${job.format}</m_nFormatTo>
<m_sTempDir>${xmlEscape(slashes(job.tempDir))}</m_sTempDir>
${job.extra ?? ''}</TaskQueueDataConvert>`
}

module.exports = { taskQueueXml, xmlEscape, slashes }
