package ai.hooware.droiddock.paste;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class PasteProvider extends ContentProvider {
    private File file(Uri uri) throws FileNotFoundException {
        String id = uri.getLastPathSegment();
        if (id == null || !id.matches("[a-f0-9]{32}")) throw new FileNotFoundException();
        File file = new File(new File(getContext().getFilesDir(), "paste"), id);
        if (!file.isFile()) throw new FileNotFoundException();
        return file;
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) {
        String mime = uri.getQueryParameter("mime");
        return mime != null && mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+") ? mime : "application/octet-stream";
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = file(uri);
            MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
            String mime = getType(uri);
            String suffix = ".bin";
            if ("image/png".equals(mime)) suffix = ".png";
            else if ("image/jpeg".equals(mime)) suffix = ".jpg";
            else if ("image/webp".equals(mime)) suffix = ".webp";
            else if ("image/gif".equals(mime)) suffix = ".gif";
            else if ("application/pdf".equals(mime)) suffix = ".pdf";
            else if ("text/plain".equals(mime)) suffix = ".txt";
            else if ("application/zip".equals(mime)) suffix = ".zip";
            cursor.addRow(new Object[] { "DroidDock-" + uri.getLastPathSegment() + suffix, file.length() });
            return cursor;
        } catch (FileNotFoundException ignored) { return null; }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
}
