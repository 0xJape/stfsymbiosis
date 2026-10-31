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
        self.database_dir = tempfile.TemporaryDirectory()
        self.original_database_path = app_module.DATABASE_PATH
        app_module.DATABASE_PATH = os.path.join(self.database_dir.name, "test.db")
        app_module.init_database()
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.DATABASE_PATH = self.original_database_path
        self.database_dir.cleanup()

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

    def test_finalize_inference_marks_low_confidence_for_review(self):
        result = app_module.finalize_inference(
            "sigatoka", 0.5, 12, False,
            [{"class": "healthy", "score": 0.3}, {"class": "sigatoka", "score": 0.5}],
        )
        self.assertEqual(result["display_class"], "unknown")
        self.assertEqual(result["review_status"], "pending")
        self.assertEqual(result["top_predictions"][0]["class"], "sigatoka")

    def test_review_queue_and_status_update(self):
        result = {
            "id": "review-me", "filename": "leaf.png", "class": "sigatoka",
            "confidence": 0.5, "severity_pct": 10, "mock": False,
            "lat": 7.0, "lon": 125.0, "color": "#000",
            "timestamp": "2026-01-01T00:00:00Z", "inference_status": "uncertain",
            "confidence_threshold": 0.7,
            "top_predictions": [{"class": "sigatoka", "score": 0.5}],
            "review_status": "pending",
        }
        app_module.save_detection(result)
        self.assertEqual(len(self.client.get("/api/review").get_json()["results"]), 1)
        response = self.client.patch(
            "/api/detections/review-me/review", json={"review_status": "confirmed"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/review").get_json()["results"], [])

    def test_review_page_renders(self):
        response = self.client.get("/review")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Uncertain detections", response.data)

    def test_history_page_renders(self):
        response = self.client.get("/history")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Scan history", response.data)

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

    def test_detection_history_survives_new_request(self):
        result = {
            "id": "saved-detection",
            "filename": "leaf.jpg",
            "class": "sigatoka",
            "confidence": 0.87,
            "severity_pct": None,
            "mock": False,
            "lat": 6.1164,
            "lon": 125.1716,
            "color": "#B23A2E",
            "timestamp": "2026-10-31T00:00:00Z",
        }
        app_module.save_detection(result)

        response = self.client.get("/api/history")

        self.assertEqual(response.status_code, 200)
        saved = response.get_json()["groups"][0]["results"][0]
        self.assertEqual(saved["id"], "saved-detection")
        self.assertEqual(saved["class"], "sigatoka")

    def test_weather_rejects_invalid_coordinates(self):
        response = self.client.get("/api/weather?lat=NaN&lon=10")
        self.assertEqual(response.status_code, 400)

    def test_spatiotemporal_requires_three_valid_boundary_points(self):
        response = self.client.post("/api/spatiotemporal", json={"boundary": [{"lat": 6, "lon": 125}]})
        self.assertEqual(response.status_code, 400)

    def test_spatiotemporal_analyzes_selected_boundary(self):
        expected = {"sample_count": 4, "timeline": [], "summary": {"favorable_days": 0}}
        boundary = [
            {"lat": 6.10, "lon": 125.10},
            {"lat": 6.20, "lon": 125.10},
            {"lat": 6.15, "lon": 125.20},
        ]
        with patch.object(app_module, "fetch_boundary_temperature", return_value=expected) as fetch:
            response = self.client.post("/api/spatiotemporal", json={"boundary": boundary})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), expected)
        self.assertEqual(len(fetch.call_args.args[0]), 3)

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
