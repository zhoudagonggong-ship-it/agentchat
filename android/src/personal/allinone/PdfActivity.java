package personal.allinone;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Toast;
import java.io.File;

/** Shows a PDF with the system's own PdfRenderer, one page under another. */
public class PdfActivity extends Activity {
  private static final int MAX_PAGES = 60;
  private PdfRenderer renderer;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    setTitle(getIntent().getStringExtra("title"));
    LinearLayout pages = new LinearLayout(this);
    pages.setOrientation(LinearLayout.VERTICAL);
    pages.setBackgroundColor(Color.rgb(242, 242, 247));
    ScrollView scroll = new ScrollView(this);
    scroll.addView(pages);
    setContentView(scroll);
    try {
      renderer = new PdfRenderer(ParcelFileDescriptor.open(new File(getIntent().getStringExtra("path")), ParcelFileDescriptor.MODE_READ_ONLY));
      int width = getResources().getDisplayMetrics().widthPixels;
      int gap = (int) (8 * getResources().getDisplayMetrics().density);
      for (int i = 0; i < Math.min(renderer.getPageCount(), MAX_PAGES); i++) {
        PdfRenderer.Page page = renderer.openPage(i);
        int height = (int) ((long) width * page.getHeight() / page.getWidth());
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.WHITE);
        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
        page.close();
        ImageView view = new ImageView(this);
        view.setImageBitmap(bitmap);
        view.setAdjustViewBounds(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = gap;
        pages.addView(view, lp);
      }
      if (renderer.getPageCount() > MAX_PAGES) Toast.makeText(this, "只显示前 " + MAX_PAGES + " 页", Toast.LENGTH_LONG).show();
    } catch (Exception e) {
      Toast.makeText(this, "无法打开这个 PDF", Toast.LENGTH_LONG).show();
      finish();
    }
  }

  @Override
  protected void onDestroy() {
    if (renderer != null) renderer.close();
    super.onDestroy();
  }
}
