import { installRecorder } from '../lib/recorder-core';

/**
 * The context recorder (INV-1147), registered only for origins the person
 * added in Options, in the page's MAIN world at document_start. It keeps a
 * small ring buffer of console errors and warnings, uncaught errors, unhandled
 * rejections and failed fetch/XHR requests (method, url, status, duration —
 * never bodies, never headers). The buffer is read when a capture is taken.
 */
installRecorder(window);
