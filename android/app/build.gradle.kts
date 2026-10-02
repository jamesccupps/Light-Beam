import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing: keystore.properties (git-ignored) points at keystore/beam-release.jks.
val signing = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "app.beam.android"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "app.beam.android"
        minSdk = 29
        targetSdk = 36
        versionCode = 12
        versionName = "1.7.0"
    }

    signingConfigs {
        if (!signing.isEmpty) {
            create("release") {
                storeFile = rootProject.file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (!signing.isEmpty) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "/kotlin/**", "DebugProbesKt.bin")
        }
    }

    testOptions {
        unitTests {
            // Robolectric smoke tests inflate the real layouts and themes.
            isIncludeAndroidResources = true
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        // The newest AndroidX releases need compileSdk 37, which isn't installed here.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

// Integration tests talk to a real Beam server when BEAM_TEST_URL / BEAM_TEST_KEY are set.
tasks.withType<Test>().configureEach {
    systemProperty("beam.url", providers.environmentVariable("BEAM_TEST_URL").orElse("").get())
    systemProperty("beam.key", providers.environmentVariable("BEAM_TEST_KEY").orElse("").get())
    // Optional: a second, empty server for the screenshot test (writes PNGs to build/screenshots).
    systemProperty("beam.shots.url", providers.environmentVariable("BEAM_SHOTS_URL").orElse("").get())
    systemProperty("beam.shots.key", providers.environmentVariable("BEAM_SHOTS_KEY").orElse("").get())
    systemProperty("beam.dist", providers.environmentVariable("BEAM_TEST_DIST").orElse("").get())
    systemProperty("beam.shots.dist", providers.environmentVariable("BEAM_SHOTS_DIST").orElse("").get())
    // The server script, for tests that start (and move) their own scratch servers.
    systemProperty("beam.server.js", providers.environmentVariable("BEAM_SERVER_JS").orElse("").get())
    // Ports those servers may use ("8813-8819"); any free port when unset.
    systemProperty("beam.test.ports", providers.environmentVariable("BEAM_TEST_PORTS").orElse("").get())
    // BEAM_PERF=1 also runs the slow perf measurements (idle traffic over a minute); their table goes to build/perf.
    systemProperty("beam.perf", providers.environmentVariable("BEAM_PERF").orElse("").get())
    systemProperty("beam.perf.idle", providers.environmentVariable("BEAM_PERF_IDLE_S").orElse("").get())
    systemProperty("beam.netsim", providers.environmentVariable("BEAM_NETSIM_URL").orElse("").get())
    systemProperty("beam.perf.dir", layout.buildDirectory.dir("perf").get().asFile.absolutePath)
    systemProperty("beam.shots.dir", layout.buildDirectory.dir("screenshots").get().asFile.absolutePath)
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.material:material:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test:core:1.7.0")
    // Real org.json for JVM tests (android.jar only has stubs).
    testImplementation("org.json:json:20250517")
}

// Publishes the signed release to ../dist for the Beam server: beam.apk plus the sidecar
// beam.apk.json that the server's update check reads (docs/API.md, "App updates").
// Run: gradlew publishApk
val publishApk by tasks.registering {
    group = "distribution"
    description = "Builds the signed release APK and copies it with its version sidecar to ../dist."
    dependsOn("assembleRelease")
    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk")
    val distDir = rootProject.layout.projectDirectory.dir("../dist").asFile
    val name = android.defaultConfig.versionName
    val code = android.defaultConfig.versionCode
    doLast {
        val source = apk.get().asFile
        // (without android/keystore.properties the release build is unsigned and isn't written under this name)
        check(source.isFile) { "No signed release APK at $source: create a signing key and android/keystore.properties (README, \"Building the apps\")" }
        distDir.mkdirs()
        // APK first (through a temporary name), then the sidecar: the server offers the update once both exist.
        val temp = File(distDir, "beam.apk.tmp")
        source.copyTo(temp, overwrite = true)
        val target = File(distDir, "beam.apk")
        if (target.exists()) target.delete()
        check(temp.renameTo(target)) { "Couldn't write $target" }
        File(distDir, "beam.apk.json").writeText("{\"version\": \"$name\", \"versionCode\": $code}\n")
        logger.lifecycle("Published Beam $name ($code) to ${target.canonicalPath}")
    }
}
