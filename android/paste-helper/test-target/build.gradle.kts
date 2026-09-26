plugins {
    id("com.android.application") version "9.3.2"
}

android {
    namespace = "ai.hooware.droiddock.pastetest"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.hooware.droiddock.pastetest"
        minSdk = 31
        targetSdk = 35
    }
}
