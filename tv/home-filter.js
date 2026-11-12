/* Luma Home compositor key filter (`home.sh enable` registers it in
 * com.webos.surfacemanager.keyFilters). LG's compositor loads it with Qt.include within seconds of
 * a cold boot, long before the Homebrew hooks (~50 s). While the TV boots it asks luma-early
 * (com.webos.service.lumahome, src/bin/luma-early.rs) to take over Home (webOS 5/6/24: mount Luma
 * over LG's Home executable; webOS 25/26: mount the staged Luma manifest over LG's Home app) and
 * then opens Home. Keys pass through unchanged. ES5 for LG's QML engine.
 */
var lumaHomeBoot = ''; // "" until bootd answers, then "booting" or "done"
var lumaHomeEarly = ''; // "" until luma-early answers, then "ready" or "failed"
var lumaHomeTries = 0;
var lumaHomeWaiting = false; // a retry is scheduled
var lumaHomeFront = '';
var lumaHomeLaunches = 0;
var lumaHomeShown = false; // Home came to the front after a launch from here
// The selected Home target; the native helper (tv-helper/src/home.rs) writes it into the installed copy.
var lumaHomeTarget = 'com.webos.app.home';

function lumaHomeParse(payload) {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

function lumaHomeRetry() {
  lumaHomeWaiting = false;
  lumaHomePrepare();
}

function lumaHomePrepare() {
  if (lumaHomeEarly || lumaHomeBoot !== 'booting' || lumaHomeWaiting || lumaHomeTries >= 180) {
    return;
  }
  lumaHomeTries++;
  // ls-hubd routes the call only after its volatile scan, and an unroutable call gets no reply:
  // ask again on one timer (boot status updates do not start more) for up to 45 s. A short
  // interval matters on webOS 25/26, where bootd launches Home ~1 s after the scan.
  lumaHomeWaiting = true;
  genericTimer.set(250, lumaHomeRetry);
  lunaCall.send('com.webos.service.lumahome', '/prepare', '{}', function (payload) {
    try {
      var r = lumaHomeParse(payload);
      if (lumaHomeEarly || !r || typeof r.exitCode !== 'number') return;
      lumaHomeEarly = r.returnValue === true ? 'ready' : 'failed';
      lumaHomeOpen();
    } catch (error) {
      console.warn('luma home filter: ' + error);
    }
  });
}

// Home is a system app: SAM takes its launch at once, while normal apps wait for
// minimal-boot-done (~25-35 s). Only over an empty screen or the input bootd opened, so a choice
// the owner made meanwhile stays. Called again on every foreground change until Home is shown:
// the snapshot's LG Home can still be in front when the mount is ready, and Live TV follows it.
function lumaHomeOpen() {
  if (
    lumaHomeEarly !== 'ready' ||
    lumaHomeShown ||
    lumaHomeFront === lumaHomeTarget ||
    lumaHomeLaunches >= 2
  )
    return;
  if (lumaHomeFront && !/^com\.webos\.app\.(livetv|hdmi\d|externalinput\..*)$/.test(lumaHomeFront))
    return;
  lumaHomeLaunches++;
  lunaCall.send(
    'com.webos.applicationManager',
    '/launch',
    JSON.stringify({ id: lumaHomeTarget }),
    function () {}
  );
  // Right after the snapshot's Home stopped, SAM can accept a launch without starting anything.
  genericTimer.set(8000, lumaHomeOpen);
}

// Called by LG's compositor once the file is loaded.
// oxlint-disable-next-line no-unused-vars
function init() {
  try {
    lunaCall.subscribe(
      'com.webos.bootManager',
      '/getBootStatus',
      '{}',
      function (payload) {
        try {
          var r = lumaHomeParse(payload);
          if (!r || !r.returnValue || !r.signals) return;
          // Only a cold boot: reloading the filter while the TV is in use never takes the screen.
          lumaHomeBoot = r.signals['boot-done']
            ? 'done'
            : lumaHomeBoot === ''
              ? 'booting'
              : lumaHomeBoot;
          lumaHomePrepare();
        } catch (error) {
          console.warn('luma home filter: ' + error);
        }
      },
      true
    );
    lunaCall.subscribe(
      'com.webos.applicationManager',
      '/getForegroundAppInfo',
      '{}',
      function (payload) {
        try {
          var r = lumaHomeParse(payload);
          lumaHomeFront = (r && r.appId) || '';
          if (lumaHomeFront === lumaHomeTarget && lumaHomeLaunches) lumaHomeShown = true;
          else lumaHomeOpen();
        } catch (error) {
          console.warn('luma home filter: ' + error);
        }
      },
      true
    );
  } catch (error) {
    console.warn('luma home filter: ' + error);
  }
}

// The handler named in the key filter chain (tv-helper/src/home.rs); keys pass through.
// oxlint-disable-next-line no-unused-vars
function lumaHomeKey() {
  return KeyPolicy.NextPolicy;
}
