package personal.allinone;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * The right pane's browser: a real browser view laid over the pane's place on the page, so any site
 * (including ones that refuse to be embedded) opens and keeps its sign-in. It has no bridge to the
 * workbench page: sites opened here cannot reach the app.
 */
final class PaneBrowser {
  private final Activity activity;
  private final WebView view;
  private final Consumer<String> onState;
  private boolean shown = false;

  @SuppressLint("SetJavaScriptEnabled")
  PaneBrowser(Activity activity, FrameLayout root, Consumer<String> onState) {
    this.activity = activity;
    this.onState = onState;
    view = new WebView(activity);
    view.setBackgroundColor(Color.WHITE);
    view.setVisibility(View.GONE);
    WebSettings s = view.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setBuiltInZoomControls(true);
    s.setDisplayZoomControls(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setSupportMultipleWindows(false); // pop-ups open in place
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, true); // sign-in pages often need them
    view.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
        String scheme = request.getUrl().getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) return false;
        try {
          activity.startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); // mailto:, app links …
        } catch (Exception ignored) {
          // nothing can open it
        }
        return true;
      }
      @Override public void onPageStarted(WebView v, String url, Bitmap icon) { report(true); }
      @Override public void onPageFinished(WebView v, String url) { report(false); }
      @Override public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { report(v.getProgress() < 100); }
    });
    view.setWebChromeClient(new WebChromeClient() {
      @Override public void onReceivedTitle(WebView v, String title) { report(v.getProgress() < 100); }
    });
    view.setDownloadListener((url, ua, disposition, mime, length) -> {
      try {
        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
      } catch (Exception ignored) {
        // no app for it
      }
    });
    root.addView(view, new FrameLayout.LayoutParams(1, 1));
  }

  void open(String url) {
    view.loadUrl(url);
  }

  /** Puts the browser exactly over the pane's slot; numbers are CSS pixels of the page. */
  void place(float x, float y, float w, float h) {
    float d = activity.getResources().getDisplayMetrics().density;
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, Math.round(w * d)), Math.max(1, Math.round(h * d)));
    lp.leftMargin = Math.round(x * d);
    lp.topMargin = Math.round(y * d);
    view.setLayoutParams(lp);
    if (!shown) {
      shown = true;
      view.setVisibility(View.VISIBLE);
    }
  }

  void hide() {
    shown = false;
    view.setVisibility(View.GONE);
  }

  void nav(String action) {
    switch (action) {
      case "back": if (view.canGoBack()) view.goBack(); break;
      case "forward": if (view.canGoForward()) view.goForward(); break;
      case "reload": view.reload(); break;
      case "stop": view.stopLoading(); break;
      default: break;
    }
  }

  /** The system back gesture goes back inside the browser first. */
  boolean back() {
    if (shown && view.canGoBack()) {
      view.goBack();
      return true;
    }
    return false;
  }

  private void report(boolean loading) {
    try {
      JSONObject s = new JSONObject();
      s.put("url", view.getUrl() == null ? "" : view.getUrl());
      s.put("title", view.getTitle() == null ? "" : view.getTitle());
      s.put("canBack", view.canGoBack());
      s.put("canForward", view.canGoForward());
      s.put("loading", loading);
      onState.accept(s.toString());
    } catch (Exception ignored) {
      // state is informational
    }
  }
}
