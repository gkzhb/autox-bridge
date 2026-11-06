/* Rhino/AutoX fixed, non-sensitive diagnostic; no request inputs or permissions. */
(function () {
    var record = { kind: 'phonectl.autox-selfcheck.v1', ok: false };
    try {
        if (typeof shizuku !== 'function' || !shizuku.isAlive()) {
            throw new Error('SHIZUKU_NOT_CONNECTED');
        }
        var identity = shizuku('id -u');
        if (Number(identity.code) !== 0 || String(identity.result).trim() !== '2000') {
            throw new Error('IDENTITY_UNCONFIRMED');
        }
        record.identity = { uid: 2000, verified: true };
        var r = shizuku("/system/bin/sh -c 'printf \"AUTOX_STDOUT\\n\"; printf \"AUTOX_STDERR\\n\" >&2; exit 7'");
        record.probe = { stdout: String(r.result), stderr: String(r.error), code: Number(r.code), identityVerified: false };
        record.ok = record.probe.stdout.indexOf('AUTOX_STDOUT') !== -1 && record.probe.stderr.indexOf('AUTOX_STDERR') !== -1 && record.probe.code === 7;
        if (!record.ok) record.error = { code: 'PROBE_MISMATCH' };
    } catch (e) {
        record.error = { code: 'SELFCHECK_FAILED', message: String(e.message || e) };
    }
    console.log(JSON.stringify(record));
    if (typeof __phonectlSelfcheckResult === 'function') __phonectlSelfcheckResult(record);
}());
