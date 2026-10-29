package personal.allinone;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileNotFoundException;

/** Hands downloaded files (cache/files only) to other apps for viewing, read-only. */
public class FilesProvider extends ContentProvider {
  private static final String AUTHORITY = "personal.allinone.files";

  static Uri uriFor(File file) {
    return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(file.getName()).build();
  }

  private File fileFor(Uri uri) throws FileNotFoundException {
    File dir = new File(getContext().getCacheDir(), "files");
    String name = uri.getLastPathSegment();
    File file = new File(dir, name == null ? "" : name);
    try {
      if (!file.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator) || !file.isFile()) throw new FileNotFoundException();
    } catch (java.io.IOException e) {
      throw new FileNotFoundException();
    }
    return file;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("read only");
    return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public String getType(Uri uri) {
    String ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString());
    String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    return type != null ? type : "application/octet-stream";
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    try {
      File file = fileFor(uri);
      MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
      cursor.addRow(new Object[] {file.getName(), file.length()});
      return cursor;
    } catch (FileNotFoundException e) {
      return null;
    }
  }

  @Override public boolean onCreate() { return true; }
  @Override public Uri insert(Uri uri, ContentValues values) { return null; }
  @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
