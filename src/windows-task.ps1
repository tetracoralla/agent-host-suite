# Public Task Scheduler 2.0 adapter. JSON data arrives on stdin, never as code.
# No task is registered by prepare/validate/observe. Mutations recheck the
# complete expected definition and ACL in the same native process.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)

function Fail([string]$code) { throw $code }
function Missing($failure) {
    $exception = $failure.Exception
    while ($null -ne $exception) {
        if ($exception.HResult -eq -2147024894 -or $exception.HResult -eq -2147024893) { return $true }
        $exception = $exception.InnerException
    }
    return $false
}
function Folder {
    try { return $scheduler.GetFolder('\openAdam') }
    catch { if (Missing $_) { return $null }; throw }
}
function Task {
    $folder = Folder
    if ($null -eq $folder) { return $null }
    try { return $folder.GetTask($name) }
    catch { if (Missing $_) { return $null }; throw }
}
function Sddl([string]$text) {
    $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($text)
    return $descriptor.GetSddlForm([System.Security.AccessControl.AccessControlSections]::All)
}
function Definition([string]$xml) {
    # COM owns XML parsing/default expansion. Preserve its complete serialization;
    # never compare only the launcher or discard unknown XML fields.
    if ($xml.Length -gt 1048576 -or $xml -match '<!DOCTYPE|<!ENTITY') { Fail 'SERVICE_DEFINITION_INVALID' }
    $definition = $scheduler.NewTask(0)
    $definition.XmlText = $xml
    if ($definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) { Fail 'SERVICE_PRIOR_STATE_UNRESTORABLE' }
    $account = $definition.Principal.UserId
    if ($account -notmatch '^S-1-') {
        $account = (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    if ($account -cne $sid) { Fail 'SERVICE_PRIOR_STATE_UNRESTORABLE' }
    if ($definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0) { Fail 'SERVICE_PRIOR_STATE_UNRESTORABLE' }
    # A logon trigger can be restored without replaying a registration/time event.
    if ($definition.Triggers.Count -ne 1 -or $definition.Triggers.Item(1).Type -ne 9) { Fail 'SERVICE_PRIOR_STATE_UNRESTORABLE' }
    return $definition
}
function Describe($task) {
    if ($null -eq $task) { return $null }
    if (-not [string]::Equals($task.Path, $request.taskName, [StringComparison]::OrdinalIgnoreCase)) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
    $definition = Definition $task.Definition.XmlText
    return @{ xml = [string]$definition.XmlText; sddl = (Sddl ($task.GetSecurityDescriptor(7))); state = [int]$task.State }
}
function Matches($actual, $expected) {
    if ($null -eq $actual -or $null -eq $expected) { return $null -eq $actual -and $null -eq $expected }
    return $actual.xml -ceq $expected.xml -and $actual.sddl -ceq $expected.sddl
}

try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 4194304) { Fail 'SERVICE_REQUEST_LIMIT' }
    $request = $inputText | ConvertFrom-Json
    if ($request.protocol -cne 'openadam.windows-task.v0.1' -or $request.taskName -cnotmatch '^\\openAdam\\AgentHostRuntime(?:\.[A-Za-z0-9._-]+)?$' -or $request.taskName.Length -gt 240) { Fail 'SERVICE_REQUEST_INVALID' }
    $name = $request.taskName.Substring('\openAdam\'.Length)
    if ($request.operation -cin @('file-security', 'set-file-security', 'validate-file-security')) {
        $sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner,Group'
        if ($request.operation -ceq 'validate-file-security') { $security = Sddl $request.security }
        else {
            if (-not [IO.Path]::IsPathRooted($request.path)) { Fail 'SERVICE_REQUEST_INVALID' }
            $item = Get-Item -LiteralPath $request.path -Force
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
            if ($request.operation -ceq 'set-file-security') {
                $acl = New-Object System.Security.AccessControl.FileSecurity
                $acl.SetSecurityDescriptorSddlForm($request.security, $sections)
                Set-Acl -LiteralPath $request.path -AclObject $acl
            }
            $security = Sddl ((Get-Acl -LiteralPath $request.path).GetSecurityDescriptorSddlForm($sections))
        }
        @{ protocol = 'openadam.windows-task.v0.1'; security = $security } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.Write($_) }
        exit 0
    }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $result = $null
    switch -CaseSensitive ($request.operation) {
        'observe' { $result = Describe (Task) }
        'validate' {
            $definition = Definition $request.task.xml
            if (-not [string]::Equals($definition.Actions.Item(1).Path, $request.launcherPath, [StringComparison]::OrdinalIgnoreCase) -or $definition.Actions.Item(1).Arguments -cne '') { Fail 'SERVICE_PRIOR_STATE_UNRESTORABLE' }
            if (($request.task.state -eq 1) -ne (-not $definition.Settings.Enabled)) { Fail 'SERVICE_DEFINITION_INVALID' }
            $result = @{ xml = [string]$definition.XmlText; sddl = (Sddl $request.task.sddl); state = [int]$request.task.state }
        }
        'prepare' {
            if (-not [IO.Path]::IsPathRooted($request.launcherPath) -or $request.launcherPath -match '[\x00-\x1f\x7f"]') { Fail 'SERVICE_REQUEST_INVALID' }
            $definition = $scheduler.NewTask(0)
            $definition.RegistrationInfo.Author = 'openAdam'
            $definition.RegistrationInfo.Date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            $definition.RegistrationInfo.URI = $request.taskName
            $definition.RegistrationInfo.Source = 'openadam.agent-host-runtime.v0.1'
            $definition.Principal.UserId = $sid
            $definition.Principal.LogonType = 3
            $definition.Principal.RunLevel = 0
            $definition.Settings.Enabled = $true
            $definition.Settings.ExecutionTimeLimit = 'PT0S'
            $definition.Settings.DisallowStartIfOnBatteries = $false
            $definition.Settings.StopIfGoingOnBatteries = $false
            $definition.Settings.MultipleInstances = 2
            $trigger = $definition.Triggers.Create(9)
            $trigger.UserId = $sid
            $action = $definition.Actions.Create(0)
            $action.Path = $request.launcherPath
            $definition = Definition $definition.XmlText
            # Explicit current-user + SYSTEM permissions; registration must not
            # silently add a different principal ACE to the recorded ACL.
            $result = @{ xml = [string]$definition.XmlText; sddl = (Sddl "O:${sid}G:${sid}D:P(A;;FA;;;SY)(A;;FA;;;${sid})"); state = 4 }
        }
        { $_ -ceq 'remove' -or $_ -ceq 'create' -or $_ -ceq 'run' } {
            $task = Task
            $actual = Describe $task
            if (-not (Matches $actual $request.expected)) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
            if ($request.operation -ceq 'remove') {
                if ($null -ne $task) {
                    $task.Stop(0)
                    $until = [DateTime]::UtcNow.AddSeconds(6)
                    do {
                        $task = Task
                        $actual = Describe $task
                        if ($null -eq $task) { break }
                        if (-not (Matches $actual $request.expected)) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
                        if ($actual.state -ne 4 -and $actual.state -ne 2) { break }
                        if ([DateTime]::UtcNow -ge $until) { Fail 'SERVICE_ROLLBACK_CLEANUP_INCOMPLETE' }
                        Start-Sleep -Milliseconds 100
                    } while ($true)
                    if ($null -ne $task) { (Folder).DeleteTask($name, 0) }
                }
                $result = Describe (Task)
            } elseif ($request.operation -ceq 'create') {
                if ($null -ne $task) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
                $definition = Definition $request.task.xml
                if ($definition.XmlText -cne $request.task.xml -or (Sddl $request.task.sddl) -cne $request.task.sddl) { Fail 'SERVICE_DEFINITION_INVALID' }
                $folder = Folder
                if ($null -eq $folder) { $folder = $scheduler.GetFolder('\').CreateFolder('openAdam', $null) }
                # CREATE, DONT_ADD_PRINCIPAL_ACE, IGNORE_REGISTRATION_TRIGGERS.
                # CREATE refuses a task that appeared after the preceding read.
                $null = $folder.RegisterTaskDefinition($name, $definition, 50, $null, $null, 3, $request.task.sddl)
                $result = Describe (Task)
            } else {
                if ($null -eq $task) { Fail 'ENVIRONMENT_RESOURCE_CHANGED' }
                $null = $task.Run($null)
                $result = Describe (Task)
            }
        }
        default { Fail 'SERVICE_REQUEST_INVALID' }
    }
    @{ protocol = 'openadam.windows-task.v0.1'; task = $result } | ConvertTo-Json -Depth 8 -Compress | ForEach-Object { [Console]::Out.Write($_) }
} catch {
    $code = [string]$_.Exception.Message
    if ($code -cnotmatch '^(SERVICE_[A-Z_]+|ENVIRONMENT_RESOURCE_CHANGED)$') { $code = 'SERVICE_NATIVE_FAILED' }
    @{ protocol = 'openadam.windows-task.v0.1'; error = $code } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.Write($_) }
    exit 1
}
