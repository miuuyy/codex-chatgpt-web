# Windows native-model recovery

The bridge preserves Codex's built-in `openai` provider and official model catalog. While the
bridge is healthy, select any native model directly from the normal Codex model picker. Native
requests are forwarded to the official backend; when `store` is false, local response-item IDs are
removed so a thread can switch safely from a browser-backed model to a native model.

## Emergency switch to native

Close or stop the current Codex task. From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-route.ps1 -Mode Native -StopBridge
```

Restart Codex Desktop. The command:

- verifies the bridge integration journal;
- backs up `%USERPROFILE%\.codex\config.toml`;
- restores the exact previous `openai_base_url` value, or removes the bridge route if none existed;
- optionally stops only the `CodexChatGPTWebBridge` scheduled task.

Check the selected route:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-route.ps1 -Mode Status
```

## Re-enable after repair

Start the bridge service and confirm health:

```powershell
schtasks /Run /TN CodexChatGPTWebBridge
Invoke-RestMethod http://127.0.0.1:17841/healthz
```

Only after `healthz` reports `status: ok`, restore the bridge route:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-route.ps1 -Mode Bridge
```

Restart Codex Desktop.

## Manual fallback if the recovery script cannot run

1. Copy `%USERPROFILE%\.codex\config.toml` to a backup file.
2. Open the original and remove the top-level line:

   ```toml
   openai_base_url = "http://127.0.0.1:17841/v1"
   ```

3. Remove the adjacent `Managed by codex-chatgpt-web` comment.
4. Do not change `model_provider`, authentication, MCP, sandbox, or approval settings.
5. Restart Codex Desktop and choose a native model.

Do not delete `%USERPROFILE%\.codex-chatgpt-web` during recovery. It contains the journal needed
to restore the exact prior configuration.
