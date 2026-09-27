plugins {
    id("com.android.application") version "9.4.1"
}

android {
    namespace = "ai.hooware.droiddock.paste"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.hooware.droiddock.paste"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
}
