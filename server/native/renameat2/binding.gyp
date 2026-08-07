{
  "targets": [
    {
      "target_name": "renameat2_exchange",
      "conditions": [
        ["OS=='linux'", {
          "sources": ["renameat2_exchange.c"],
          "cflags": ["-Wall", "-Wextra", "-std=gnu11"]
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
