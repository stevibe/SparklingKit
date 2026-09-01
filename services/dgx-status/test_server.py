import unittest

import server


class StatusReporterTests(unittest.TestCase):
    def test_parse_meminfo_uses_binary_kibibytes(self):
        result = server.parse_meminfo("MemTotal: 1024 kB\nMemAvailable: 256 kB\n")
        self.assertEqual(result["MemTotal"], 1024 * 1024)
        self.assertEqual(result["MemAvailable"], 256 * 1024)

    def test_flag_value_supports_split_and_equals_forms(self):
        self.assertEqual(server.flag_value(["vllm", "--port", "8331"], "--port"), "8331")
        self.assertEqual(server.flag_value(["vllm", "--port=8331"], "--port"), "8331")

    def test_optional_number_handles_unavailable_values(self):
        self.assertIsNone(server.optional_number("N/A"))
        self.assertEqual(server.optional_number("42", int), 42)


if __name__ == "__main__":
    unittest.main()
