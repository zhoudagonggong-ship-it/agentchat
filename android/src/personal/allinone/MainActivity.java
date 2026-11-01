package personal.allinone;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** The app is a thin shell: the interface is the hub's own web page; native code does what a page cannot. */
public class MainActivity extends Activity {
  private static final int REQ_NOTIFY = 2;
  private static final int REQ_CAMERA = 3;
  private static final int REQ_FILES = 4;
  private static final String TAILSCALE = "com.tailscale.ipn";
  private ValueCallback<Uri[]> fileCallback;
  private FrameLayout root;
  private WebView web;
  private PaneBrowser browser;
  private PermissionRequest cameraRequest;
  private boolean failingOver = false;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    web.setBackgroundColor(Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    web.addJavascriptInterface(new Bridge(), "AllinOneNative");
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(PermissionRequest request) {
        // Only the app's own scan page may use the camera.
        boolean camera = java.util.Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        String page = web.getUrl();
        if (!camera || !"file".equals(request.getOrigin().getScheme()) || page == null || !isLocalPage(Uri.parse(page))) {
          request.deny();
          return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
          request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
          cameraRequest = request;
          requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
        }
      }

      /** A video's full-screen button: the player covers everything, and turning the phone turns it. */
      private View fullscreen;

      @Override
      public void onShowCustomView(View view, CustomViewCallback callback) {
        if (fullscreen != null) {
          callback.onCustomViewHidden();
          return;
        }
        fullscreen = view;
        view.setBackgroundColor(Color.BLACK);
        root.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
      }

      @Override
      public void onHideCustomView() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
      }

      /** The composer's + button: the system picker (gallery, files, camera apps), several at once. */
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
        try {
          startActivityForResult(Intent.createChooser(pick, Hubs.L("选择图片或文件", "Pick pictures or files")), REQ_FILES);
        } catch (Exception e) {
          fileCallback = null;
          return false;
        }
        return true;
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (isLocalPage(uri)) return false; // the app's own setup / scan / offline pages
        if ("https".equals(uri.getScheme()) && Hubs.isMemberHost(MainActivity.this, uri.getHost())) {
          // The hub moved to another member computer: remember it and follow.
          String url = uri.getScheme() + "://" + uri.getHost() + ":" + uri.getPort() + "/";
          if (!url.equals(Hubs.hubUrl(MainActivity.this))) Hubs.save(MainActivity.this, url, null);
          return false;
        }
        startActivity(new Intent(Intent.ACTION_VIEW, uri)); // ordinary links open in the browser
        return true;
      }

      @Override
      public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return sharedResponse(request.getUrl());
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) failOver();
      }
    });
    // The workbench page fills the screen; the right pane's browser floats over its slot when shown.
    FrameLayout root = new FrameLayout(this);
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    browser = new PaneBrowser(this, root, (json) -> web.evaluateJavascript("window.onBrowserState && window.onBrowserState(" + json + ")", null));
    fitSystemBars(root);
    setContentView(root);

    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
    }
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }
    if (!handle(getIntent())) loadHub(null);
  }

  /**
   * Android draws apps edge to edge: keep the page clear of the status bar (its clock and icons) and the
   * gesture bar and keyboard, give that strip the page's own colour, and use icons that show on it.
   */
  private void fitSystemBars(FrameLayout root) {
    this.root = root;
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
      Insets ime = insets.getInsets(WindowInsets.Type.ime());
      v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
      return WindowInsets.CONSUMED;
    });
    paintSystemBars();
  }

  /** Light or dark, following the system as the page does. */
  private void paintSystemBars() {
    boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    root.setBackgroundColor(night ? 0xFF111111 : 0xFFF7F7F7); // the page's --bg
    int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
    WindowInsetsController bars = getWindow().getInsetsController();
    if (bars != null) bars.setSystemBarsAppearance(night ? 0 : light, light); // dark icons on the light page
  }

  @Override
  public void onConfigurationChanged(Configuration config) {
    super.onConfigurationChanged(config);
    paintSystemBars(); // the manifest keeps the activity across a light/dark switch
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handle(intent);
  }

  // ---------- shared from another app ----------

  /** What was shared last, until the page takes it: files copied into the cache (the sender's grant ends with it). */
  private final java.util.List<JSONObject> sharedFiles = new java.util.ArrayList<>();
  private final java.util.List<File> sharedData = new java.util.ArrayList<>();
  private String sharedText = null;
  private boolean shareWaiting = false;

  private static final long MAX_SHARE = 25L * 1024 * 1024; // what a message may carry

  /** Copies what another app shared, then tells the page (which asks for it when it starts, too). */
  @SuppressWarnings("deprecation") // the typed getters need Android 13; this app runs from Android 11
  private void takeShare(Intent intent) {
    java.util.List<Uri> uris = new java.util.ArrayList<>();
    if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
      java.util.ArrayList<android.os.Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (list != null) for (android.os.Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
    } else if (intent.getParcelableExtra(Intent.EXTRA_STREAM) instanceof Uri) {
      uris.add((Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM));
    }
    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
    String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
    new Thread(() -> {
      File dir = new File(getCacheDir(), "shared");
      java.util.List<JSONObject> files = new java.util.ArrayList<>();
      java.util.List<File> data = new java.util.ArrayList<>();
      if (dir.exists()) for (File old : dir.listFiles()) old.delete();
      dir.mkdirs();
      for (Uri uri : uris.subList(0, Math.min(uris.size(), 9))) {
        String name = displayName(uri);
        String mime = getContentResolver().getType(uri);
        File file = new File(dir, data.size() + "-" + safeName(name));
        long size = 0;
        try (InputStream in = getContentResolver().openInputStream(uri); FileOutputStream out = new FileOutputStream(file)) {
          byte[] buf = new byte[65536];
          for (int n; (n = in.read(buf)) > 0; ) {
            size += n;
            if (size > MAX_SHARE) throw new Exception("too big");
            out.write(buf, 0, n);
          }
        } catch (Exception e) {
          file.delete();
          final String why = size > MAX_SHARE ? Hubs.L("超过 25 MB", "is over 25 MB") : Hubs.L("读不出来", "could not be read");
          runOnUiThread(() -> toast(Hubs.L("「" + name + "」" + why + "，没有收", "\"" + name + "\" " + why + "; left out")));
          continue;
        }
        try {
          files.add(new JSONObject().put("name", name).put("mime", mime != null ? mime : "application/octet-stream").put("size", size));
          data.add(file);
        } catch (Exception ignored) {
          // JSON of plain strings does not fail
        }
      }
      String said = text != null ? (subject != null && !text.contains(subject) ? subject + "\n" + text : text) : null;
      runOnUiThread(() -> {
        synchronized (sharedFiles) {
          sharedFiles.clear();
          sharedFiles.addAll(files);
          sharedData.clear();
          sharedData.addAll(data);
          sharedText = said;
          shareWaiting = !files.isEmpty() || said != null;
        }
        String current = web.getUrl();
        String hub = Hubs.hubUrl(this);
        if (hub == null) toast(Hubs.L("请先和主电脑配对", "Pair with the main computer first"));
        else if (current != null && current.startsWith(hub)) web.evaluateJavascript("window.onShared && window.onShared()", null);
        else loadHub(null); // the page asks for it once it is up
      });
    }).start();
  }

  private String displayName(Uri uri) {
    try (android.database.Cursor c = getContentResolver().query(uri, new String[] {android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
    } catch (Exception ignored) {
      // some apps share files without a name
    }
    String last = uri.getLastPathSegment();
    return last != null ? last : "file";
  }

  /** The page's /__shared/<n>: a shared file, served as if the hub had it (same address, so the page reads it plainly). */
  private android.webkit.WebResourceResponse sharedResponse(Uri uri) {
    String hub = Hubs.hubUrl(this);
    if (hub == null || !uri.toString().startsWith(hub) || uri.getPath() == null || !uri.getPath().startsWith("/__shared/")) return null;
    try {
      int i = Integer.parseInt(uri.getPath().substring("/__shared/".length()));
      File file;
      String mime;
      synchronized (sharedFiles) {
        file = sharedData.get(i);
        mime = sharedFiles.get(i).getString("mime");
      }
      return new android.webkit.WebResourceResponse(mime, null, new java.io.FileInputStream(file));
    } catch (Exception e) {
      return new android.webkit.WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new java.io.ByteArrayInputStream(new byte[0]));
    }
  }

  /** Pairing links, notification taps and shares from other apps. Returns true when it took care of loading. */
  private boolean handle(Intent intent) {
    if (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
      takeShare(intent);
      if (web.getUrl() == null) loadHub(null);
      return true;
    }
    Uri data = intent.getData();
    if (data != null && "allinone".equals(data.getScheme()) && "pair".equals(data.getHost())) {
      pair(data);
      return true;
    }
    String session = intent.getStringExtra("session");
    if (session != null) {
      loadHub(session);
      return true;
    }
    return false;
  }

  private void loadHub(String session) {
    String hub = Hubs.hubUrl(this);
    if (hub == null) {
      web.loadUrl("file:///android_asset/setup.html");
      return;
    }
    startForegroundService(new Intent(this, NotifyService.class).setAction("start"));
    String target = hub + (session != null ? "#s=" + Uri.encode(session) : "");
    String current = web.getUrl();
    if (session != null && current != null && current.startsWith(hub)) {
      web.evaluateJavascript("location.hash='s=" + Uri.encode(session) + "'", null);
    } else {
      web.loadUrl(target);
    }
  }

  private void pair(Uri link) {
    String host = link.getQueryParameter("hub");
    String port = link.getQueryParameter("port");
    String code = link.getQueryParameter("code");
    if (host == null || code == null || !host.endsWith(".ts.net")) {
      toast(Hubs.L("二维码无效", "Not a pairing code"));
      return;
    }
    toast(Hubs.L("正在配对…", "Pairing…"));
    new Thread(() -> {
      try {
        String url = "https://" + host + ":" + (port != null ? port : Hubs.PORT) + "/api/pair?code=" + Uri.encode(code);
        JSONObject reply = new JSONObject(Hubs.get(url, 8000, 15000));
        Hubs.save(this, reply.getString("url"), reply.optJSONArray("members"));
        runOnUiThread(() -> {
          toast(Hubs.L("配对成功", "Paired"));
          loadHub(null);
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast(Hubs.L("配对失败：" + e.getMessage() + "（请确认手机已连接 Tailscale）", "Pairing failed: " + e.getMessage() + " (is Tailscale on?)")));
      }
    }).start();
  }

  /** The hub did not answer: ask the member computers where it is now. */
  private void failOver() {
    if (failingOver) return;
    failingOver = true;
    new Thread(() -> {
      String found = Hubs.discover(this);
      runOnUiThread(() -> {
        failingOver = false;
        if (found != null && !found.equals(web.getUrl())) web.loadUrl(found);
        else web.loadUrl("file:///android_asset/offline.html");
      });
    }).start();
  }

  private void goBack() {
    if (browser.back()) return;
    web.evaluateJavascript("window.onNativeBack ? window.onNativeBack() : false", (handled) -> {
      if (!"true".equals(handled)) moveTaskToBack(true);
    });
  }

  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    goBack();
  }

  @Override
  @SuppressWarnings("deprecation")
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQ_FILES || fileCallback == null) return;
    Uri[] picked = null;
    if (resultCode == RESULT_OK && data != null) {
      ClipData clip = data.getClipData();
      if (clip != null) {
        picked = new Uri[clip.getItemCount()];
        for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
      } else if (data.getData() != null) {
        picked = new Uri[] {data.getData()};
      }
    }
    fileCallback.onReceiveValue(picked); // null: cancelled, the page stays as it was
    fileCallback = null;
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
    if (requestCode == REQ_CAMERA && cameraRequest != null) {
      if (granted) cameraRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
      else cameraRequest.deny();
      cameraRequest = null;
    }
  }

  // ---------- files the WebView cannot show ----------

  /** A file of the hub's, downloaded into the app's cache (only the hub's own files: the page names them). */
  private File fetch(String url, String name) throws Exception {
    File dir = new File(getCacheDir(), "files");
    dir.mkdirs();
    File file = new File(dir, safeName(name));
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setConnectTimeout(8000);
    conn.setReadTimeout(60000);
    try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
      byte[] buf = new byte[65536];
      for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    } finally {
      conn.disconnect();
    }
    return file;
  }

  private static String safeName(String name) {
    String n = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    return n.isEmpty() ? "file" : n;
  }

  private boolean fromHub(String url) {
    String hub = Hubs.hubUrl(this);
    return hub != null && url.startsWith(hub);
  }

  /** Into the phone's own collections, where the gallery and other apps find it: pictures, videos, music, else downloads. */
  private void saveFile(String url, String name, String mime) {
    if (!fromHub(url)) return;
    toast(Hubs.L("正在保存 ", "Saving ") + name);
    new Thread(() -> {
      try {
        Uri collection;
        String folder;
        if (mime.startsWith("image/")) {
          collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_PICTURES;
        } else if (mime.startsWith("video/")) {
          collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_MOVIES;
        } else if (mime.startsWith("audio/")) {
          collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_MUSIC;
        } else {
          collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_DOWNLOADS;
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName(name));
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/AgentChat");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = getContentResolver().insert(collection, values);
        if (item == null) throw new Exception(Hubs.L("系统不让保存", "the system refused"));
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(60000);
        try (InputStream in = conn.getInputStream(); OutputStream out = getContentResolver().openOutputStream(item)) {
          byte[] buf = new byte[65536];
          for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
          getContentResolver().delete(item, null, null);
          throw e;
        } finally {
          conn.disconnect();
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContentResolver().update(item, values, null, null);
        String where = mime.startsWith("image/") ? Hubs.L("相册", "Pictures") : mime.startsWith("video/") ? Hubs.L("相册的视频", "Movies") : mime.startsWith("audio/") ? Hubs.L("音乐", "Music") : Hubs.L("下载", "Downloads");
        runOnUiThread(() -> toast(Hubs.L("已保存到" + where + "（AgentChat 文件夹）", "Saved to " + where + " (AgentChat folder)")));
      } catch (Exception e) {
        runOnUiThread(() -> toast(Hubs.L("保存失败：", "Could not save: ") + e.getMessage()));
      }
    }).start();
  }

  /** To another app (WeChat, a photo editor…), through the system's share sheet. */
  private void shareFile(String url, String name, String mime) {
    if (!fromHub(url)) return;
    new Thread(() -> {
      try {
        File file = fetch(url, name);
        runOnUiThread(() -> {
          Uri uri = FilesProvider.uriFor(file);
          Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
          send.setClipData(ClipData.newRawUri(name, uri));
          startActivity(Intent.createChooser(send, Hubs.L("分享 ", "Share ") + name));
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast(Hubs.L("分享失败：", "Could not share: ") + e.getMessage()));
      }
    }).start();
  }

  private void openFile(String url, String name, String mime) {
    if (!fromHub(url)) return; // only the hub's own files
    toast(Hubs.L("正在打开 ", "Opening ") + name);
    new Thread(() -> {
      try {
        File file = fetch(url, name);
        runOnUiThread(() -> {
          if ("application/pdf".equals(mime)) {
            startActivity(new Intent(this, PdfActivity.class).putExtra("path", file.getAbsolutePath()).putExtra("title", name));
          } else {
            Uri uri = FilesProvider.uriFor(file);
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
              startActivity(Intent.createChooser(view, name));
            } catch (Exception e) {
              toast(Hubs.L("手机上没有能打开这种文件的应用", "No app on this phone opens this kind of file"));
            }
          }
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast(Hubs.L("打开失败：", "Could not open: ") + e.getMessage()));
      }
    }).start();
  }

  private static boolean isLocalPage(Uri uri) {
    return uri != null && "file".equals(uri.getScheme()) && uri.getPath() != null && uri.getPath().startsWith("/android_asset/");
  }

  private void toast(String text) {
    Toast.makeText(this, text, Toast.LENGTH_LONG).show();
  }

  /** Called from the page as window.AllinOneNative.*; runs on a WebView thread. */
  private final class Bridge {
    @JavascriptInterface public void openFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.openFile(url, name, mime));
    }
    @JavascriptInterface public void saveFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.saveFile(url, name, mime));
    }
    @JavascriptInterface public void shareFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.shareFile(url, name, mime));
    }
    /** A picture is open full screen: turning the phone turns it, even with the screen's rotation locked. */
    @JavascriptInterface public void viewerOpen(boolean open) {
      runOnUiThread(() -> setRequestedOrientation(open ? ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
    }
    /** What another app shared and the page has not taken yet: {files: [{name, mime, size}], text}, or null. */
    @JavascriptInterface public String takeShared() {
      synchronized (sharedFiles) {
        if (!shareWaiting) return null;
        shareWaiting = false;
        try {
          return new JSONObject().put("files", new org.json.JSONArray(sharedFiles)).put("text", sharedText != null ? sharedText : "").toString();
        } catch (Exception e) {
          return null;
        }
      }
    }
    @JavascriptInterface public void retry() {
      runOnUiThread(() -> loadHub(null));
    }
    @JavascriptInterface public String getSettings() {
      JSONObject s = Hubs.settings(MainActivity.this);
      try {
        s.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
      } catch (Exception ignored) {
        // version is informational
      }
      return s.toString();
    }
    @JavascriptInterface public void setSettings(String json) {
      try {
        Hubs.saveSettings(MainActivity.this, new JSONObject(json));
      } catch (Exception ignored) {
        // malformed input from the page: keep the previous settings
      }
    }
    // ---- the right pane's browser ----
    @JavascriptInterface public void browserOpen(String url) {
      if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) runOnUiThread(() -> browser.open(url));
    }
    @JavascriptInterface public void browserPlace(float x, float y, float w, float h) {
      runOnUiThread(() -> browser.place(x, y, w, h));
    }
    @JavascriptInterface public void browserHide() {
      runOnUiThread(() -> browser.hide());
    }
    @JavascriptInterface public void browserNav(String action) {
      runOnUiThread(() -> browser.nav(action));
    }
    @JavascriptInterface public void markRead(String sessionId) {
      NotifyService.clear(MainActivity.this, sessionId);
    }
    @JavascriptInterface public void scan() {
      runOnUiThread(() -> web.loadUrl("file:///android_asset/scan.html"));
    }
    // ---- the offline page: why the hub cannot be reached, and the way to fix it ----
    /** "missing" (Tailscale not installed), "off" (installed, its VPN not on) or "on". */
    @JavascriptInterface public String tailscaleState() {
      if (getPackageManager().getLaunchIntentForPackage(TAILSCALE) == null) return "missing";
      ConnectivityManager cm = getSystemService(ConnectivityManager.class);
      for (Network n : cm.getAllNetworks()) {
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "on";
      }
      return "off";
    }
    /** Opens Tailscale, or its store page when it is not installed. */
    @JavascriptInterface public void openTailscale() {
      runOnUiThread(() -> {
        Intent app = getPackageManager().getLaunchIntentForPackage(TAILSCALE);
        try {
          startActivity(app != null ? app : new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + TAILSCALE)));
        } catch (Exception e) {
          startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + TAILSCALE)));
        }
      });
    }
    /**
     * Battery saving closes Tailscale (and with it every connection): "self" asks the system to let this app run in the
     * background; "tailscale" opens Tailscale's app page, where 电池 → 不受限制 is one tap away.
     */
    @JavascriptInterface public void batterySettings(String which) {
      runOnUiThread(() -> {
        try {
          if ("self".equals(which)) {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
          } else {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + TAILSCALE)));
          }
        } catch (Exception e) {
          startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
      });
    }
    @JavascriptInterface public boolean batteryFree() {
      return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }
    /** From the in-app scanner: the text of the pairing QR code. */
    @JavascriptInterface public void pairLink(String link) {
      runOnUiThread(() -> {
        Uri uri = Uri.parse(link);
        if ("allinone".equals(uri.getScheme()) && "pair".equals(uri.getHost())) pair(uri);
        else toast(Hubs.L("二维码无效", "Not a pairing code"));
      });
    }
  }
}
