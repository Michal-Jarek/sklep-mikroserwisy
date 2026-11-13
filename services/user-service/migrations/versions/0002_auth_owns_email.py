"""Auth is the authority for email uniqueness; allow retries and orphan recovery."""
from alembic import op
import sqlalchemy as sa
revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

def upgrade():
    constraints = sa.inspect(op.get_bind()).get_unique_constraints("user_profiles")
    with op.batch_alter_table("user_profiles", naming_convention={"uq": "uq_%(table_name)s_%(column_0_name)s"}) as batch:
        for constraint in constraints:
            if constraint["column_names"] == ["email"]:
                batch.drop_constraint(constraint["name"] or "uq_user_profiles_email", type_="unique")

def downgrade():
    with op.batch_alter_table("user_profiles") as batch:
        batch.create_unique_constraint("uq_user_profiles_email", ["email"])
