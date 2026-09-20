"""演示用订单模块（skill 样例语料，可安全修改/删除）。"""

DISCOUNT_RATE = 0.1


class Order:
    def __init__(self, items):
        self.items = items

    def total(self):
        return sum(item["price"] * item["qty"] for item in self.items)


def apply_discount(order):
    """对订单总额打折，供 checkout 使用。"""
    return order.total() * (1 - DISCOUNT_RATE)


def checkout(order):
    """结账入口：返回应付金额。"""
    return {"payable": apply_discount(order)}
