package __PACKAGE__;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.animation.Animation;
import android.view.animation.TranslateAnimation;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.Manifest;
import android.content.pm.PackageManager;

public class MainActivity extends Activity {

    private static final String WEBSITE_URL = "__WEBSITE_URL__";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int STORAGE_PERMISSION_REQUEST_CODE = 1002;
    private static final int PULL_THRESHOLD = 220;

    private WebView webView;
    private ProgressBar progressBar;
    private ProgressBar pullRefreshSpinner;
    private FrameLayout pullRefreshContainer;
    private LinearLayout noConnectionLayout;
    private ValueCallback<Uri[]> filePathCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout rootLayout;
    private BroadcastReceiver downloadReceiver;
    private long lastDownloadId = -1;

    private String pendingUrl;
    private String pendingUserAgent;
    private String pendingContentDisposition;
    private String pendingMimeType;

    private LinearLayout downloadBar;
    private Handler downloadBarHandler = new Handler();
    private Runnable downloadBarDismissRunnable;

    private float pullStartY = 0;
    private boolean isPulling = false;
    private boolean isRefreshing = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        );

        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        }

        setContentView(R.layout.activity_main);

        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != lastDownloadId) return;
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                DownloadManager.Query query = new DownloadManager.Query();
                query.setFilterById(id);
                Cursor cursor = dm.query(query);
                if (cursor != null && cursor.moveToFirst()) {
                    int statusCol = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int titleCol = cursor.getColumnIndex(DownloadManager.COLUMN_TITLE);
                    int status = statusCol >= 0 ? cursor.getInt(statusCol) : -1;
                    String title = titleCol >= 0 ? cursor.getString(titleCol) : "";
                    final String finalTitle = title;
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        runOnUiThread(() -> showDownloadBar(finalTitle));
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        runOnUiThread(() -> Toast.makeText(MainActivity.this, "Download gagal: " + finalTitle, Toast.LENGTH_LONG).show());
                    }
                    cursor.close();
                }
            }
        };

        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        }

        rootLayout = findViewById(R.id.rootLayout);
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        noConnectionLayout = findViewById(R.id.noConnectionLayout);
        pullRefreshContainer = findViewById(R.id.pullRefreshContainer);
        pullRefreshSpinner = findViewById(R.id.pullRefreshSpinner);
        Button retryButton = findViewById(R.id.retryButton);

        webView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (isRefreshing) return false;
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        pullStartY = event.getY();
                        isPulling = false;
                        break;
                    case MotionEvent.ACTION_MOVE:
                        float deltaY = event.getY() - pullStartY;
                        boolean atTop = !webView.canScrollVertically(-1);
                        if (atTop && deltaY > 0) {
                            isPulling = true;
                            pullRefreshContainer.setVisibility(View.VISIBLE);
                            float progress = Math.min(deltaY / PULL_THRESHOLD, 1f);
                            pullRefreshContainer.setAlpha(progress);
                            if (progress >= 1f) {
                                pullRefreshSpinner.setVisibility(View.VISIBLE);
                            } else {
                                pullRefreshSpinner.setVisibility(View.GONE);
                            }
                            return true;
                        }
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (isPulling) {
                            float delta = event.getY() - pullStartY;
                            if (delta >= PULL_THRESHOLD && isConnected()) {
                                triggerRefresh();
                            } else {
                                resetPull();
                            }
                            isPulling = false;
                        }
                        break;
                }
                return false;
            }
        });

        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public String readClipboard() {
                android.content.ClipboardManager cm = (android.content.ClipboardManager)
                    getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence text = cm.getPrimaryClip().getItemAt(0).getText();
                    return text != null ? text.toString() : "";
                }
                return "";
            }
        }, "AndroidBridge");

        rootLayout.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets insets) {
                v.setPadding(
                    insets.getSystemWindowInsetLeft(),
                    insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(),
                    insets.getSystemWindowInsetBottom()
                );
                return insets;
            }
        });

        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadWebsite();
            }
        });

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        String ua = "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";
        settings.setUserAgentString(ua);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                noConnectionLayout.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                resetPull();
                isRefreshing = false;
                CookieManager.getInstance().flush();
                view.evaluateJavascript(
                    "navigator.clipboard.readText = function() {" +
                    "  return Promise.resolve(window.AndroidBridge.readClipboard());" +
                    "};",
                    null
                );
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    Uri uri = request.getUrl();
                    String scheme = uri.getScheme();
                    if ("http".equals(scheme) || "https".equals(scheme)) {
                        return false;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Tidak dapat membuka link ini", Toast.LENGTH_SHORT).show();
                    }
                    return true;
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Tidak dapat membuka link ini", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    if (request.isForMainFrame()) {
                        resetPull();
                        isRefreshing = false;
                        webView.setVisibility(View.GONE);
                        noConnectionLayout.setVisibility(View.VISIBLE);
                        progressBar.setVisibility(View.GONE);
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                resetPull();
                isRefreshing = false;
                webView.setVisibility(View.GONE);
                noConnectionLayout.setVisibility(View.VISIBLE);
                progressBar.setVisibility(View.GONE);
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    pendingUrl = url;
                    pendingUserAgent = userAgent;
                    pendingContentDisposition = contentDisposition;
                    pendingMimeType = mimeType;
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION_REQUEST_CODE);
                    return;
                }
            }
            downloadWithManager(url, userAgent, contentDisposition, mimeType);
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent contentIntent = fileChooserParams.createIntent();
                contentIntent.setType("*/*");
                Intent chooserIntent = Intent.createChooser(contentIntent, fileChooserParams.getTitle());
                try {
                    startActivityForResult(chooserIntent, FILE_CHOOSER_REQUEST_CODE);
                } catch (ActivityNotFoundException e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                );
                rootLayout.addView(customView, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                ));
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                rootLayout.removeView(customView);
                customView = null;
                customViewCallback.onCustomViewHidden();
                webView.setVisibility(View.VISIBLE);
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                );
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setCancelable(false)
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setCancelable(false)
                    .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                android.widget.EditText input = new android.widget.EditText(MainActivity.this);
                input.setText(defaultValue);
                new android.app.AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm(input.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setCancelable(false)
                    .show();
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            loadWebsite();
        }
    }

    private void triggerRefresh() {
        isRefreshing = true;
        pullRefreshSpinner.setVisibility(View.VISIBLE);
        pullRefreshContainer.setVisibility(View.VISIBLE);
        pullRefreshContainer.setAlpha(1f);
        webView.reload();
    }

    private void resetPull() {
        pullRefreshContainer.setVisibility(View.GONE);
        pullRefreshSpinner.setVisibility(View.GONE);
        pullRefreshContainer.setAlpha(0f);
    }

    private void showDownloadBar(String fileName) {
        if (downloadBar != null) {
            rootLayout.removeView(downloadBar);
            downloadBar = null;
        }
        if (downloadBarDismissRunnable != null) {
            downloadBarHandler.removeCallbacks(downloadBarDismissRunnable);
        }

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(48, 32, 24, 32);

        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.parseColor("#212121"));
        bg.setCornerRadii(new float[]{24, 24, 24, 24, 0, 0, 0, 0});
        bar.setBackground(bg);

        if (Build.VERSION.SDK_INT >= 21) {
            bar.setElevation(16f);
        }

        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        barParams.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(barParams);

        TextView msgView = new TextView(this);
        msgView.setText("Unduhan selesai · " + fileName);
        msgView.setTextColor(Color.WHITE);
        msgView.setTextSize(13);
        msgView.setSingleLine(true);
        msgView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        msgView.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView btnBuka = new TextView(this);
        btnBuka.setText("BUKA");
        btnBuka.setTextColor(Color.parseColor("#80CBC4"));
        btnBuka.setTextSize(13);
        btnBuka.setTypeface(null, Typeface.BOLD);
        btnBuka.setPadding(32, 16, 16, 16);
        btnBuka.setOnClickListener(v -> {
            try {
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                Uri uri = dm.getUriForDownloadedFile(lastDownloadId);
                String mime = dm.getMimeTypeForDownloadedFile(lastDownloadId);
                if (uri != null) {
                    Intent open = new Intent(Intent.ACTION_VIEW);
                    open.setDataAndType(uri, mime != null ? mime : "*/*");
                    open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(Intent.createChooser(open, "Buka dengan"));
                } else {
                    Toast.makeText(this, "File tidak ditemukan", Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Toast.makeText(this, "Tidak dapat membuka file", Toast.LENGTH_SHORT).show();
            }
            dismissDownloadBar();
        });

        bar.addView(msgView);
        bar.addView(btnBuka);

        rootLayout.addView(bar);
        downloadBar = bar;

        TranslateAnimation slideUp = new TranslateAnimation(
            Animation.RELATIVE_TO_SELF, 0f,
            Animation.RELATIVE_TO_SELF, 0f,
            Animation.RELATIVE_TO_SELF, 1f,
            Animation.RELATIVE_TO_SELF, 0f
        );
        slideUp.setDuration(250);
        bar.startAnimation(slideUp);
        downloadBarDismissRunnable = this::dismissDownloadBar;
        downloadBarHandler.postDelayed(downloadBarDismissRunnable, 4000);
    }

    private void dismissDownloadBar() {
        if (downloadBar == null) return;
        TranslateAnimation slideDown = new TranslateAnimation(
            Animation.RELATIVE_TO_SELF, 0f,
            Animation.RELATIVE_TO_SELF, 0f,
            Animation.RELATIVE_TO_SELF, 0f,
            Animation.RELATIVE_TO_SELF, 1f
        );
        slideDown.setDuration(200);
        slideDown.setAnimationListener(new Animation.AnimationListener() {
            @Override public void onAnimationStart(Animation a) {}
            @Override public void onAnimationRepeat(Animation a) {}
            @Override
            public void onAnimationEnd(Animation a) {
                if (downloadBar != null) {
                    rootLayout.removeView(downloadBar);
                    downloadBar = null;
                }
            }
        });
        downloadBar.startAnimation(slideDown);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == STORAGE_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (pendingUrl != null) {
                    downloadWithManager(pendingUrl, pendingUserAgent, pendingContentDisposition, pendingMimeType);
                }
            } else {
                Toast.makeText(this, "Izin penyimpanan diperlukan untuk download", Toast.LENGTH_SHORT).show();
            }
            pendingUrl = null;
            pendingUserAgent = null;
            pendingContentDisposition = null;
            pendingMimeType = null;
        }
    }

    private void downloadWithManager(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            String cookie = CookieManager.getInstance().getCookie(url);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setTitle(fileName);
            request.setDescription("Mengunduh...");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            if (mimeType != null) request.setMimeType(mimeType);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            lastDownloadId = dm.enqueue(request);
            Toast.makeText(this, "Mengunduh: " + fileName, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download gagal: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }

    private void loadWebsite() {
        if (isConnected()) {
            noConnectionLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(WEBSITE_URL);
        } else {
            webView.setVisibility(View.GONE);
            noConnectionLayout.setVisibility(View.VISIBLE);
        }
    }

    @SuppressWarnings("deprecation")
    private boolean isConnected() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        NetworkInfo activeNetwork = cm.getActiveNetworkInfo();
        return activeNetwork != null && activeNetwork.isConnected();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
        webView.pauseTimers();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onDestroy() {
        if (downloadBarDismissRunnable != null) {
            downloadBarHandler.removeCallbacks(downloadBarDismissRunnable);
        }
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Exception e) {}
            downloadReceiver = null;
        }
        if (webView != null) {
            webView.clearHistory();
            webView.loadUrl("about:blank");
            webView.onPause();
            webView.removeAllViews();
            webView.destroyDrawingCache();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            if (webView.getWebChromeClient() != null) {
                webView.getWebChromeClient().onHideCustomView();
            }
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}