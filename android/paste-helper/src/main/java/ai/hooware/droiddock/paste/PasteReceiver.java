package ai.hooware.droiddock.paste;

import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.io.File;
import java.util.Arrays;
import java.util.Comparator;

public final class PasteReceiver extends BroadcastReceiver {
    public static final String ACTION = "ai.hooware.droiddock.paste.SET_CLIP";
    public static final String AUTHORITY = "ai.hooware.droiddock.paste.files";

    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        String id = intent.getStringExtra("id");
        String mime = intent.getStringExtra("mime");
        if (id == null || !id.matches("[a-f0-9]{32}") || mime == null ||
                mime.length() > 100 || !mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) return;
        File file = new File(new File(context.getFilesDir(), "paste"), id);
        if (!file.isFile() || file.length() == 0 || file.length() > 16 * 1024 * 1024) return;
        Uri uri = new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(id)
                .appendQueryParameter("mime", mime).build();
        ClipData clip = new ClipData("DroidDock file", new String[] { mime }, new ClipData.Item(uri));
        ClipboardManager clipboard = context.getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        clipboard.setPrimaryClip(clip);
        prune(new File(context.getFilesDir(), "paste"), id);
        setResultCode(1);
    }

    private void prune(File directory, String currentId) {
        File[] files = directory.listFiles(file -> file.isFile() && file.getName().matches("[a-f0-9]{32}"));
        if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        long cutoff = System.currentTimeMillis() - 60 * 60 * 1000;
        for (int i = 0; i < files.length; i++) {
            if (!currentId.equals(files[i].getName()) && (i >= 4 || files[i].lastModified() < cutoff)) files[i].delete();
        }
    }
}
