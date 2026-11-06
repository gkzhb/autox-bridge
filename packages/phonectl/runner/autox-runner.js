/* Fixed Rhino runner v1. PUBLIC SOURCE: no secrets. One request, no network. */
(function () {
    var config = /*PHONECTL_CONFIG*/null;
    var dir = new java.io.File(config.publicDirectory);
    var pattern = /^request-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
    var candidates = dir.listFiles();
    var found = [];
    if (candidates) for (var i = 0; i < candidates.length; i++) if (pattern.test(String(candidates[i].getName()))) found.push(candidates[i]);
    // Intent carries only the fixed runner file path. Directory single-flight
    // request discovery is explicit, not an assumed extras/script API.
    if (found.length !== 1) return;
    var file = found[0];
    var match = pattern.exec(String(file.getName()));
    var claim = new java.io.File(String(file.getPath()) + '.claim');
    if (!claim.createNewFile()) return;
    var result = {version:1,requestId:match[1],attempt:match[2]};
    try {
        if (file.length() > 32768) throw new Error('INVALID_REQUEST');
        var request = JSON.parse(String(files.read(String(file.getPath()))));
        if (request.version !== 1 || request.requestId !== match[1] || request.attempt !== match[2] || typeof request.deadline !== 'number' || Date.now() > request.deadline || request.deadline > Date.now()+3600000 || typeof request.timeoutMs !== 'number' || request.timeoutMs < 1 || request.timeoutMs > 3600000 || request.maxOutputBytes < 1 || request.maxOutputBytes > 16384) throw new Error('INVALID_REQUEST');
        var command = request.command;
        function quote(s) {return "'" + s.replace(/'/g, "'\\''") + "'";}
        var userCommand;
        if (command && command.mode === 'argv' && Array.isArray(command.argv) && command.argv.length && command.argv[0]) {
            for (var j=0;j<command.argv.length;j++) if(typeof command.argv[j] !== 'string' || command.argv[j].indexOf('\0') !== -1) throw new Error('INVALID_REQUEST');
            userCommand=command.argv.map(quote).join(' ');
        } else if(command && command.mode === 'shell' && typeof command.script === 'string' && command.script.indexOf('\0') === -1) userCommand=command.script;
        else throw new Error('INVALID_REQUEST');
        // Delete only this validated request before execution; finally retries.
        if (!file.delete() && file.exists()) throw new Error('REQUEST_CLEANUP_FAILED');
        var marker='PHONECTL_END_'+request.requestId;
        var executedCommand = 'u=$(/system/bin/id -u) || exit 125; if [ "$u" != 2000 ]; then exit 125; fi; printf \'PHONECTL_UID2000\\n\'; /system/bin/timeout -s KILL '+Math.max(1,Math.ceil(request.timeoutMs/1000))+' /system/bin/sh -c ' + quote(userCommand) + '; r=$?; printf \'\\n'+marker+'\\n\'; printf \'\\n'+marker+'\\n\' >&2; (exit "$r")';
        result.execution={command:command,userCommand:userCommand,executedCommand:executedCommand};
        if (typeof shizuku !== 'function' || !shizuku.isAlive()) throw new Error('AUTOX_UNAVAILABLE');
        // The exact same variable is passed to the host and returned for the
        // private-state consistency comparison. Not malicious-runner attestation.
        var r=shizuku(executedCommand);
        var output=String(r.result), error=String(r.error);
        function stripEnd(text) {var suffix='\n'+marker;var at=text.lastIndexOf(suffix);if(at<0||at+suffix.length!==text.length)throw new Error('RESULT_UNCONFIRMED');return text.substring(0,at);}
        output=stripEnd(output);error=stripEnd(error);
        if(output !== 'PHONECTL_UID2000' && output.indexOf('PHONECTL_UID2000\n') !== 0) throw new Error('IDENTITY_MISMATCH');
        output=output === 'PHONECTL_UID2000' ? '' : output.substring('PHONECTL_UID2000\n'.length);
        result.identity={uid:2000,verified:true};result.stdout=output;result.stderr=error;result.exitCode=Number(r.code);
        var n=new java.lang.String(output+error).getBytes('UTF-8').length;
        if(n>request.maxOutputBytes) {delete result.stdout;delete result.stderr;throw new Error('OUTPUT_LIMIT');}
        if(Date.now()>request.deadline)throw new Error('RESULT_EXPIRED');
    } catch(e) {result.error={code:String(e.message||e)};}
    finally {if(file.exists())file.delete();}
    try {
        var payload=JSON.stringify(result);
        if(new java.lang.String(payload).getBytes('UTF-8').length>131072)return;
        var intent=new android.content.Intent('com.termux.RUN_COMMAND');
        intent.setClassName('com.termux','com.termux.app.RunCommandService');
        intent.putExtra('com.termux.RUN_COMMAND_PATH',config.node);
        var args=java.lang.reflect.Array.newInstance(java.lang.Class.forName('java.lang.String'),2);
        args[0]=config.receiver;args[1]=payload;
        intent.putExtra('com.termux.RUN_COMMAND_ARGUMENTS',args);
        intent.putExtra('com.termux.RUN_COMMAND_BACKGROUND',true);
        context.startService(intent);
    } finally {claim.delete();}
}());
