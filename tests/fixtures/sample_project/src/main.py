import os


def bootstrap():
    return 1


class App:
    def __init__(self):
        self.x = 0

    def run(self):
        return self.x

    async def serve(self):
        pass


def process_data(payload):
    return payload
