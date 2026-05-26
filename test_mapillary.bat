@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Mapillary API Test Script — Door-to-Door Route Endpoints
::
:: Route under test:
::   A = 701 3rd Street, San Francisco, CA 94107
::       lat=37.77862, lng=-122.39364
::   B = 88 Colin P Kelly Junior Street, San Francisco, CA 94107
::       lat=37.78234, lng=-122.39118
::
:: Bbox formula matches App.jsx buildBboxMeters(point, 50):
::   latDelta  = 50 / 111320          ≈ 0.000449
::   lngDelta  = 50 / (111320 * cos(lat_rad))
::   SF cos(37.778°) ≈ 0.79068  →  lngDelta ≈ 0.000568
::
:: Filtering mirrors App.jsx exactly:
::   fetchNearbyMapillaryImages : is_pano = true only
::   normalizeImage             : prefer computed_geometry, haversine distance
::   selectVantageImages (fallback): sort by distanceMeters ASC, spatialDedup 15 m
::
:: Usage:  test_mapillary.bat [ACCESS_TOKEN]
:: Output: response\*.json  and  response\images\*.jpg
:: ============================================================

set TOKEN=%~1

if "!TOKEN!"=="" (
    if exist "starter\.env" (
        for /f "usebackq tokens=1,* delims==" %%a in ("starter\.env") do (
            if "%%a"=="VITE_MAPILLARY_TOKEN" set TOKEN=%%b
        )
    )
)

for /f "tokens=* delims= " %%t in ("!TOKEN!") do set TOKEN=%%t

if "!TOKEN!"=="" (
    set /p TOKEN="Enter Mapillary access token: "
)

:: ---- All available image fields (Mapillary Graph API) ----
set FIELDS=id,altitude,atomic_scale,camera_parameters,camera_type,captured_at,compass_angle,computed_altitude,computed_compass_angle,computed_geometry,computed_rotation,creator,exif_orientation,geometry,height,is_pano,make,model,organization,thumb_256_url,thumb_512_url,thumb_1024_url,thumb_2048_url,thumb_original_url,quality_score,merge_cc,mesh,sequence,sfm_cluster,width

:: ---- Pre-computed bboxes (50 m radius, matches buildBboxMeters) ----
set BBOX_A=-122.394208,37.778171,-122.393072,37.779069
set BBOX_B=-122.391748,37.781891,-122.390612,37.782789

:: ---- Output folders ----
if not exist "response"         mkdir "response"
if not exist "response\images"  mkdir "response\images"

echo.
echo ============================================================
echo  Mapillary API Test Suite
echo  Token: !TOKEN:~0,12!...
echo  Output: response\
echo ============================================================
echo.

:: ============================================================
:: TEST 1 — Point A (701 3rd St), no limit
:: ============================================================
echo [1] GET /images  Point A (701 3rd St), no limit
curl -s -w "  HTTP %%{http_code}\n" ^
  "https://graph.mapillary.com/images?access_token=!TOKEN!&fields=!FIELDS!&bbox=!BBOX_A!" ^
  -o "response\01_point_A.json"

:: ============================================================
:: TEST 2 — Point A, same call again to verify stability
:: ============================================================
echo [2] GET /images  Point A (REPEAT — compare IDs to test 1)
curl -s -w "  HTTP %%{http_code}\n" ^
  "https://graph.mapillary.com/images?access_token=!TOKEN!&fields=!FIELDS!&bbox=!BBOX_A!" ^
  -o "response\02_point_A_repeat.json"

:: ============================================================
:: TEST 3 — Point B (88 Colin P Kelly Jr St), no limit
:: ============================================================
echo [3] GET /images  Point B (88 Colin P Kelly Jr St), no limit
curl -s -w "  HTTP %%{http_code}\n" ^
  "https://graph.mapillary.com/images?access_token=!TOKEN!&fields=!FIELDS!&bbox=!BBOX_B!" ^
  -o "response\03_point_B.json"

:: ============================================================
:: TEST 4 — Single image details (first result from test 1)
:: ============================================================
echo [4] GET /{image_id}  Single image details (first from test 1)
for /f "tokens=*" %%i in ('powershell -NoProfile -Command ^
  "try { $j = Get-Content response\01_point_A.json | ConvertFrom-Json; if ($j.data -and $j.data.Count -gt 0) { $j.data[0].id } else { 'NONE' } } catch { 'NONE' }"') do set FIRST_ID=%%i

if "!FIRST_ID!"=="NONE" (
    echo   Skipped: test 1 returned no results
) else if "!FIRST_ID!"=="" (
    echo   Skipped: could not parse test 1 response
) else (
    echo   Image ID: !FIRST_ID!
    curl -s -w "  HTTP %%{http_code}\n" ^
      "https://graph.mapillary.com/!FIRST_ID!?access_token=!TOKEN!&fields=!FIELDS!" ^
      -o "response\04_single_image_!FIRST_ID!.json"
)

:: ============================================================
:: TEST 5 — Detections for that image
:: ============================================================
echo [5] GET /{image_id}/detections  Segmentation for first image
if not "!FIRST_ID!"=="NONE" if not "!FIRST_ID!"=="" (
    curl -s -w "  HTTP %%{http_code}\n" ^
      "https://graph.mapillary.com/!FIRST_ID!/detections?access_token=!TOKEN!&fields=id,value,created_at,geometry,image" ^
      -o "response\05_detections_!FIRST_ID!.json"
)

:: ============================================================
:: Pretty-print JSON
:: ============================================================
echo.
echo Pretty-printing JSON responses...
for %%f in ("response\*.json") do (
    powershell -NoProfile -Command ^
      "try { Get-Content '%%f' | ConvertFrom-Json | ConvertTo-Json -Depth 10 | Set-Content '%%f' -Encoding UTF8; Write-Host '  %%f' } catch { Write-Host '  SKIP %%f (not valid JSON)' }"
)

:: ============================================================
:: App.jsx filtering:
::   1. is_pano = true                       (fetchNearbyMapillaryImages filter)
::   2. distanceMeters via haversine,        (normalizeImage — prefers computed_geometry)
::      prefer computed_geometry over geometry
::   3. sort by distanceMeters ASC           (selectVantageImages fallback)
::   4. spatial dedup, min 15 m              (spatialDedup)
:: ============================================================
echo.
echo Applying App.jsx filtering (is_pano=true, distance ASC, spatial dedup 15 m)...

powershell -NoProfile -Command ^
  "function Hav($lat1,$lon1,$lat2,$lon2){" ^
  "  $R=6371000.0;" ^
  "  $dLat=($lat2-$lat1)*[Math]::PI/180;" ^
  "  $dLon=($lon2-$lon1)*[Math]::PI/180;" ^
  "  $a=[Math]::Sin($dLat/2)*[Math]::Sin($dLat/2)+[Math]::Cos($lat1*[Math]::PI/180)*[Math]::Cos($lat2*[Math]::PI/180)*[Math]::Sin($dLon/2)*[Math]::Sin($dLon/2);" ^
  "  $R*2*[Math]::Atan2([Math]::Sqrt($a),[Math]::Sqrt(1.0-$a))}" ^
  "function Dedup($imgs){" ^
  "  $kept=@();" ^
  "  foreach($i in $imgs){" ^
  "    $gc=if($i.computed_geometry){$i.computed_geometry.coordinates}else{$i.geometry.coordinates};" ^
  "    if(-not $gc){continue};" ^
  "    $near=$false;" ^
  "    foreach($s in $kept){" ^
  "      $sc=if($s.computed_geometry){$s.computed_geometry.coordinates}else{$s.geometry.coordinates};" ^
  "      if($sc -and (Hav $gc[1] $gc[0] $sc[1] $sc[0]) -lt 15){$near=$true;break}};" ^
  "    if(-not $near){$kept+=$i}};" ^
  "  ,$kept}" ^
  "function Show($file,$label,$rlat,$rlon){" ^
  "  $raw=try{(Get-Content $file|ConvertFrom-Json).data}catch{@()};" ^
  "  $total=$raw.Count;" ^
  "  $panos=@($raw|Where-Object{$_.is_pano -eq $true});" ^
  "  $withDist=@($panos|ForEach-Object{" ^
  "    $c=if($_.computed_geometry){$_.computed_geometry.coordinates}else{$_.geometry.coordinates};" ^
  "    $d=if($c){[Math]::Round((Hav $rlat $rlon $c[1] $c[0]))}else{9999};" ^
  "    $_|Add-Member -NotePropertyName distanceMeters -NotePropertyValue $d -PassThru -Force});" ^
  "  $sorted=@($withDist|Sort-Object distanceMeters);" ^
  "  $deduped=@(Dedup $sorted);" ^
  "  Write-Host('  '+$label+'  total_returned='+$total+'  panos='+$panos.Count+'  after_dedup='+$deduped.Count);" ^
  "  foreach($img in $deduped){" ^
  "    $coords=if($img.computed_geometry){$img.computed_geometry.coordinates}else{$img.geometry.coordinates};" ^
  "    Write-Host('    id='+$img.id+'  dist='+$img.distanceMeters+'m  compass='+$img.computed_compass_angle+'/'+$img.compass_angle+'  camera='+$img.camera_type+'  captured='+$img.captured_at)};" ^
  "  @{total_returned=$total;pano_count=$panos.Count;filtered=$deduped}|ConvertTo-Json -Depth 10|Set-Content ($file -replace '\.json','_filtered.json') -Encoding UTF8}" ^
  "Show 'response\01_point_A.json' 'Point A' 37.77862 (-122.39364);" ^
  "Show 'response\02_point_A_repeat.json' 'Point A (repeat)' 37.77862 (-122.39364);" ^
  "Show 'response\03_point_B.json' 'Point B' 37.78234 (-122.39118)"

:: ============================================================
:: Stability check: compare filtered IDs across both Point A runs
:: ============================================================
echo.
echo Checking if Point A run 1 and run 2 produce identical filtered set...
powershell -NoProfile -Command ^
  "$a=try{@((Get-Content 'response\01_point_A_filtered.json'|ConvertFrom-Json).filtered.id)}catch{@()};" ^
  "$b=try{@((Get-Content 'response\02_point_A_repeat_filtered.json'|ConvertFrom-Json).filtered.id)}catch{@()};" ^
  "$match=(($a|Sort-Object) -join ',') -eq (($b|Sort-Object) -join ',');" ^
  "if($match){Write-Host '  STABLE: identical filtered sets on both runs'}" ^
  "else{Write-Host '  UNSTABLE: filtered set differs between runs';Write-Host('    Run1: '+($a -join ', '));Write-Host('    Run2: '+($b -join ', '))}"

:: ============================================================
:: Download thumbnails for filtered set from each point
:: ============================================================
echo.
echo Downloading thumbnails for Point A (filtered)...
powershell -NoProfile -Command ^
  "$items=try{@((Get-Content 'response\01_point_A_filtered.json'|ConvertFrom-Json).filtered)}catch{@()};" ^
  "$i=0;foreach($img in $items){if($img.thumb_1024_url){" ^
  "  $out='response\images\A_'+$i+'_'+$img.id+'.jpg';" ^
  "  Write-Host('  '+$img.id+' -> '+$out);" ^
  "  try{Invoke-WebRequest -Uri $img.thumb_1024_url -OutFile $out -UseBasicParsing}catch{Write-Host('  ERROR: '+$_)};" ^
  "  $i++}}"

echo Downloading thumbnails for Point B (filtered)...
powershell -NoProfile -Command ^
  "$items=try{@((Get-Content 'response\03_point_B_filtered.json'|ConvertFrom-Json).filtered)}catch{@()};" ^
  "$i=0;foreach($img in $items){if($img.thumb_1024_url){" ^
  "  $out='response\images\B_'+$i+'_'+$img.id+'.jpg';" ^
  "  Write-Host('  '+$img.id+' -> '+$out);" ^
  "  try{Invoke-WebRequest -Uri $img.thumb_1024_url -OutFile $out -UseBasicParsing}catch{Write-Host('  ERROR: '+$_)};" ^
  "  $i++}}"

echo.
echo ============================================================
echo  Done.
echo  Key outputs:
echo    *_filtered.json  — is_pano=true, sorted by distance, deduped
echo    STABLE / UNSTABLE shows API response variance
echo  JSON files  : response\*.json
echo  Thumbnails  : response\images\*.jpg
echo ============================================================
echo.
pause
