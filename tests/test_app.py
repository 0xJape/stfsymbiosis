import io
import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module


class InputValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_module.app.config["TESTING"] = True

    def setUp(self):
        self.client = app_module.app.test_client()

    def test_parse_coordinates_accepts_valid_values(self):
        self.assertEqual(app_module.parse_coordinates("7.07", "125.61"), (7.07, 125.61))

    def test_parse_coordinates_rejects_invalid_values(self):
        for lat, lon in [
            (None, "0"),
            ("north", "0"),
            ("NaN", "0"),
            ("91", "0"),
            ("0", "181"),
        ]:
            with self.subTest(lat=lat, lon=lon):
                with self.assertRaises(ValueError):
                    app_module.parse_coordinates(lat, lon)

    def test_safe_image_extension_rejects_untrusted_or_unknown_extensions(self):
        self.assertEqual(app_module.get_safe_image_extension("../../leaf.PNG"), ".png")
        self.assertIsNone(app_module.get_safe_image_extension("../../payload.py"))
        self.assertIsNone(app_module.get_safe_image_extension(""))

    def test_single_detection_rejects_out_of_range_coordinates(self):
        response = self.client.post(
            "/api/detect",
            data={
                "image": (io.BytesIO(b"image data"), "leaf.png"),
                "lat": "91",
                "lon": "125",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Latitude must be between", response.get_json()["error"])

    def test_single_detection_rejects_non_image_uploads(self):
        response = self.client.post(
            "/api/detect",
            data={
                "image": (io.BytesIO(b"not an image"), "payload.py"),
                "lat": "7",
                "lon": "125",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("supported image", response.get_json()["error"])

    def test_single_detection_saves_image_and_returns_detection(self):
        original_upload_dir = app_module.UPLOAD_DIR
        with tempfile.TemporaryDirectory() as upload_dir:
            app_module.UPLOAD_DIR = upload_dir
            try:
                with patch.object(
                    app_module,
                    "run_inference",
                    return_value={"class": "healthy", "confidence": 0.9, "severity_pct": 0, "mock": False},
                ), patch.object(app_module, "fetch_weather", return_value=None):
                    response = self.client.post(
                        "/api/detect",
                        data={
                            "image": (io.BytesIO(b"image data"), "../../leaf.PNG"),
                            "lat": "7",
                            "lon": "125",
                        },
                    )
            finally:
                app_module.UPLOAD_DIR = original_upload_dir

            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            self.assertEqual(data["class"], "healthy")
            self.assertEqual(os.path.splitext(data["filename"])[1], ".png")
            self.assertTrue(os.path.isfile(os.path.join(upload_dir, data["filename"])))

    def test_batch_rejects_unsupported_file_before_processing(self):
        response = self.client.post(
            "/api/detect_batch",
            data={
                "images": [
                    (io.BytesIO(b"image data"), "leaf.png"),
                    (io.BytesIO(b"not an image"), "payload.py"),
                ],
                "lat": "7",
                "lon": "125",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Every upload", response.get_json()["error"])

    def test_batch_detection_processes_valid_images(self):
        original_upload_dir = app_module.UPLOAD_DIR
        with tempfile.TemporaryDirectory() as upload_dir:
            app_module.UPLOAD_DIR = upload_dir
            try:
                with patch.object(
                    app_module,
                    "run_inference",
                    return_value={"class": "healthy", "confidence": 0.9, "severity_pct": 0, "mock": False},
                ), patch.object(app_module, "fetch_weather", return_value=None):
                    response = self.client.post(
                        "/api/detect_batch",
                        data={
                            "images": [
                                (io.BytesIO(b"first image"), "first.jpg"),
                                (io.BytesIO(b"second image"), "second.webp"),
                            ],
                            "lat": "7",
                            "lon": "125",
                        },
                    )
            finally:
                app_module.UPLOAD_DIR = original_upload_dir

            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            self.assertEqual(len(data["results"]), 2)
            self.assertEqual(data["summary"], {"healthy": 2})
            self.assertEqual(len(os.listdir(upload_dir)), 2)

    def test_weather_rejects_invalid_coordinates(self):
        response = self.client.get("/api/weather?lat=NaN&lon=10")
        self.assertEqual(response.status_code, 400)

    def test_speak_rejects_malformed_request_without_running_tts(self):
        response = self.client.post("/api/speak", data="not json", content_type="text/plain")
        self.assertEqual(response.status_code, 400)

        response = self.client.post("/api/speak", json={"text": ["not", "text"]})
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_missing_or_invalid_json(self):
        response = self.client.post("/api/chat", data="not json", content_type="text/plain")
        self.assertEqual(response.status_code, 400)

        response = self.client.post("/api/chat", json={"message": " "})
        self.assertEqual(response.status_code, 400)

    def test_chat_context_handles_malformed_batch_summary(self):
        result = app_module.format_context_for_chat({"batch": True, "summary": "invalid"})
        self.assertIn("Batch detection summary:", result)


if __name__ == "__main__":
    unittest.main()
