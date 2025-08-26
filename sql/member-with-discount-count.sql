select count(*) as working_member_count from customers
  left join memberships on customers.membership_id = memberships.membership_id
where
  expires > now() and discvaliduntil > now()