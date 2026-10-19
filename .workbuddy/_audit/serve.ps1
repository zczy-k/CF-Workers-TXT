param([int]$Port = 8791, [string]$Root = 'd:\Users\i\Desktop\CF-Workers-TXT')
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "serving $Root on http://127.0.0.1:$Port/"
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { $client.Close(); continue }
    while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') { }
    $parts = $requestLine.Split(' ')
    $rawurl = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
    $path = $rawurl.Split('?')[0].TrimStart('/')
    $path = [System.Uri]::UnescapeDataString($path)
    $full = Join-Path $Root ($path -replace '/', '\')
    $bytes = $null
    if (Test-Path -LiteralPath $full -PathType Leaf) { $bytes = [System.IO.File]::ReadAllBytes($full) }
    if ($null -ne $bytes) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = switch ($ext) {
        '.js'   { 'text/javascript; charset=utf-8' }
        '.mjs'  { 'text/javascript; charset=utf-8' }
        '.html' { 'text/html; charset=utf-8' }
        '.json' { 'application/json' }
        '.css'  { 'text/css' }
        default { 'application/octet-stream' }
      }
      $header = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($hb, 0, $hb.Length)
      $stream.Write($bytes, 0, $bytes.Length)
    } else {
      $hb = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
      $stream.Write($hb, 0, $hb.Length)
    }
    $stream.Flush()
  } catch { }
  finally { $client.Close() }
}
