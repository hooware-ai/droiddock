package ai.hooware.droiddock.pastetest;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.InputStream;

public final class TestActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        EditText input = new EditText(this);
        input.setHint("Focus here, then paste an image or file");
        TextView result = new TextView(this);
        result.setContentDescription("No rich paste received");
        input.setOnReceiveContentListener(new String[] { "image/*", "application/*" }, (View view, android.view.ContentInfo payload) -> {
            try (InputStream stream = getContentResolver().openInputStream(payload.getClip().getItemAt(0).getUri())) {
                int count = 0;
                byte[] buffer = new byte[4096];
                for (int n; (n = stream.read(buffer)) >= 0;) count += n;
                result.setText("Received " + count + " bytes");
                result.setContentDescription("Rich paste received");
            } catch (Exception error) {
                result.setText("Could not read rich paste");
                result.setContentDescription("Rich paste failed");
            }
            return null;
        });
        layout.addView(input);
        layout.addView(result);
        setContentView(layout);
        input.requestFocus();
    }
}
